import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { ranchWorkerLimit } from '../src/ranch.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(name, { file = ':memory:', level = 3, resume = false } = {}) {
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn)
    if (!resume)
        edit((state) => {
            state.tasks = []
            state.player.basic_info.lv = 30
            state.home.level = level
        })
    const state = () => store.load(session.id).state
    const station = (guid, type = 0) => call('PetStationInHomeHub', { pet_guid: guid, type })
    return { store, session, game, call, edit, state, station, close: () => store.close() }
}
const snapshot = (f) => structuredClone(f.store.load(f.session.id))
const home = (packets) =>
    protocol.decode(protocol.byName.get('CSProtoHomeSync').rsp, packets.find((packet) => packet.id === 6102).payload)
const pet = (f, guid) => f.state().pets.find((entry) => entry.guid === guid)

test('6552 includes actual home-level base slots: sixth/seventh at level3, exact full rejection and repeat/remove/reentry', () => {
    const f = fixture('hub-capacity-level3')
    try {
        const ids = f
            .state()
            .pets.slice(0, 8)
            .map((entry) => entry.guid)
        assert.equal(tables.find('home_level', 3).worker_max, 2)
        assert.equal(ranchWorkerLimit(tables, f.state(), 'worker_max'), 7)
        for (const [index, guid] of ids.slice(0, 7).entries()) {
            const packets = f.station(guid)
            assert.deepEqual(home(packets).home_hub.station_pets, ids.slice(0, index + 1))
            assert.equal(pet(f, guid).work_status, 7)
            assert(
                packets.findIndex((packet) => packet.id === 6102) < packets.findIndex((packet) => packet.id === 6552),
            )
            assert(
                packets.findIndex((packet) => packet.id === 6517) < packets.findIndex((packet) => packet.id === 6552),
            )
        }
        const before = snapshot(f)
        assert.throws(
            () => f.station(ids[7]),
            (error) => error.code === ErrorCode.HomeHubFull,
        )
        assert.deepEqual(snapshot(f), before)
        assert.deepEqual(
            f.station(ids[5]).map((packet) => packet.id),
            [6552],
        )
        assert.equal(f.state().home.stationPets.length, 7)
        f.station(ids[2], 1)
        assert.equal(f.state().home.stationPets.length, 6)
        f.station(ids[7])
        assert.equal(f.state().home.stationPets.length, 7)
    } finally {
        f.close()
    }
})

test('6552 level1 stays five and all current level increments use the same shared native-derived capacity formula', () => {
    const f = fixture('hub-capacity-level1', { level: 1 })
    try {
        const ids = f
            .state()
            .pets.slice(0, 6)
            .map((entry) => entry.guid)
        for (const row of tables.get('home_level')) {
            const state = structuredClone(f.state())
            state.home.level = row.id
            const unlocked = tables
                .get('home_freeworkposition')
                .filter((entry) => entry.unlockCondition === '2004#1')
                .reduce((sum, entry) => sum + entry.num, 0)
            assert.equal(ranchWorkerLimit(tables, state, 'worker_max'), row.worker_max + unlocked)
        }
        for (const guid of ids.slice(0, 5)) f.station(guid)
        const before = snapshot(f)
        assert.throws(
            () => f.station(ids[5]),
            (error) => error.code === ErrorCode.HomeHubFull,
        )
        assert.deepEqual(snapshot(f), before)
    } finally {
        f.close()
    }
})

test('real6532 assignments and replacements share the6552 pool; outHub frees one actual slot and6552 withdrawal clears the active build', () => {
    const f = fixture('hub-capacity-production')
    try {
        const row = tables.find('home_building_production', 20201)
        const required = String(row.laborType).split('|').map(Number),
            sizes = String(row.petSize).split('|').map(Number)
        const workers = f
            .state()
            .pets.filter(
                (entry) =>
                    entry.labor_infos.some((labor) => required.includes(labor.labor_id) && labor.labor_grade > 0) &&
                    sizes.includes(tables.find('pet_home_talent', entry.config_id)?.sizeType),
            )
            .slice(0, 3)
            .map((entry) => entry.guid)
        assert.equal(workers.length, 3)
        const [a, b, c] = workers
        const pool = [
            a,
            b,
            ...f
                .state()
                .pets.map((entry) => entry.guid)
                .filter((guid) => !workers.includes(guid))
                .slice(0, 5),
        ]
        f.edit((state) =>
            state.home.builds.push({
                guid: 200,
                build_id: 20201,
                build_type: 2,
                status: 1,
                locate: { block_id: 101, anchor: 6750400, direction: 0 },
            }),
        )
        for (const guid of pool) f.station(guid)
        const dispatch = (guid, out_hub = false) =>
            f.call('PetStationed', { pet_guid: guid, build_guid: 200, build_type: 1, out_hub })
        dispatch(a)
        assert.equal(pet(f, a).work_build, 200)
        assert.equal(f.state().home.stationPets.length, 7)
        dispatch(b)
        assert.equal(pet(f, a).work_status, 7)
        assert.equal(pet(f, b).work_build, 200)
        assert.equal(f.state().home.stationPets.length, 7)
        dispatch(c, true)
        assert.equal(pet(f, b).work_status, 0)
        assert(!f.state().home.stationPets.includes(b))
        assert.equal(pet(f, c).work_build, 200)
        assert.equal(f.state().home.stationPets.length, 7)
        f.station(c, 1)
        assert.equal(f.state().home.builds.find((build) => build.guid === 200).station_pet_guid, '0')
        assert.equal(pet(f, c).work_status, 0)
        assert.equal(f.state().home.stationPets.length, 6)
        f.station(c)
        assert.equal(f.state().home.stationPets.length, 7)
    } finally {
        f.close()
    }
})

test('6552 extra-slot HomeSync,PetInfoSync and acknowledgment failures roll back all state and preserve owned-only selection', () => {
    const f = fixture('hub-capacity-rollback'),
        encode = protocol.encode.bind(protocol)
    try {
        const ids = f
            .state()
            .pets.slice(0, 6)
            .map((entry) => entry.guid)
        for (const guid of ids.slice(0, 5)) f.station(guid)
        for (const name of ['CSProtoHomeSync', 'CSProtoPetInfoSync', 'CSProtoPetStationInHomeHub']) {
            const before = snapshot(f)
            let hit = false
            const type = protocol.byName.get(name).rsp
            protocol.encode = (protocolType, ...args) => {
                if (protocolType === type) {
                    hit = true
                    throw Error('hub-capacity-codec-' + name)
                }
                return encode(protocolType, ...args)
            }
            assert.throws(() => f.station(ids[5]), /hub-capacity-codec-/)
            assert(hit)
            assert.deepEqual(snapshot(f), before)
            protocol.encode = encode
        }
        for (const guid of [
            '999999999',
            ((9n << 56n) | 500048n).toString(),
            ((2n << 56n) | (500048n << 32n) | 0xffffffffn).toString(),
        ]) {
            const before = snapshot(f)
            assert.throws(() => f.station(guid), /Pet not owned/)
            assert.deepEqual(snapshot(f), before)
        }
        f.station(ids[5])
        assert.equal(f.state().home.stationPets.length, 6)
    } finally {
        protocol.encode = encode
        f.close()
    }
})

test('earned home capacity and the sixth/seventh6552 occupants persist through actual SQLite reopen and new-session login', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-hub-capacity-')),
        file = path.join(directory, 'state.sqlite')
    let f
    try {
        f = fixture('hub-capacity-file', { file })
        const ids = f
            .state()
            .pets.slice(0, 8)
            .map((entry) => entry.guid)
        for (const guid of ids.slice(0, 7)) f.station(guid)
        f.close()
        f = fixture('hub-capacity-file', { file, resume: true })
        assert.equal(f.state().home.level, 3)
        assert.deepEqual(f.state().home.stationPets, ids.slice(0, 7))
        assert.throws(
            () => f.station(ids[7]),
            (error) => error.code === ErrorCode.HomeHubFull,
        )
        f.station(ids[0], 1)
        f.station(ids[7])
        assert.equal(f.state().home.stationPets.length, 7)
    } finally {
        f?.close()
        const target = path.resolve(directory)
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
        assert(path.basename(target).startsWith('home-hub-capacity-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
