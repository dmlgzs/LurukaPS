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
import { grantRewards, parseRewards } from '../src/rewards.js'
import { productionSeconds } from '../src/production-time.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const candidates = [500181, 500185, 500306, 500360, 500766],
    request = { build_guid: 20, product_id: 1, count: 1 }
function setup(filename = ':memory:', initialize = true) {
    let now = 1800000000,
        seq = 1
    const store = new Store(filename),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    call('EnterGame', { open_id: 'accessory-worker-home-size' })
    if (initialize)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = Number(tables.get('game').find((row) => row.title === 'HOME_ID').value)
            s.player.basic_info.lv = 45
            s.home.level = 10
            s.home.builds.push({
                guid: 20,
                build_id: 20241,
                build_type: 8,
                status: 1,
                locate: { block_id: 101, anchor: 6750239, direction: 0 },
            })
            s.materialDungeonRecords = Object.fromEntries(
                tables.get('dungeon_material').map((row) => [
                    row.id,
                    {
                        material_id: row.id,
                        material_star: 0,
                        success_count: 1,
                        difficulty_id: row.diff,
                        success_time: String(now),
                    },
                ]),
            )
            grantRewards(
                tables,
                s,
                candidates.map((itemid) => ({ itemtype: 5, itemid, itemnum: 1 })),
            )
            grantRewards(
                tables,
                s,
                parseRewards(tables.find('accessory_product', 1).material).map((row) => ({ ...row, itemnum: 10000 })),
            )
        })
    return {
        store,
        session,
        game,
        call,
        state: () => store.load(session.id).state,
        worker: (id) => store.read(session.id, (s) => s.pets.find((pet) => pet.config_id === id).guid),
        advance: (n) => {
            now += n
            return game.tick(session.id)
        },
        now: () => now,
    }
}
const station = (f, pet, extra = {}) =>
    f.call('PetStationed', { pet_guid: f.worker(pet), build_guid: 20, build_type: 1, ...extra })
const jobs = (f) => f.state().home.productionJobs[20]
const worker = (f, id) => f.state().pets.find((pet) => pet.guid === f.worker(id))
const db = (f) => ({
    rows: f.store.db.prepare('SELECT * FROM players').all(),
    logs: f.store.db.prepare('SELECT count(*) AS n FROM request_log').get(),
    pending: structuredClone([...f.store.pending]),
})
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((item) => item.itemid === id).reduce((sum, item) => sum + item.itemnum, 0)
const error = (code) => (e) => {
    assert.equal(e.code, code)
    return true
}

test('actual labor11 workers with combat body4/5 are accepted using configured home size2/3 and sync before ACK', () => {
    const f = setup()
    try {
        for (const id of candidates) {
            const talent = tables.find('pet_home_talent', id),
                petConfig = tables.find('pet', id)
            assert([2, 3].includes(talent.sizeType))
            assert([4, 5].includes(petConfig.bodyType))
            assert(worker(f, id).labor_infos.some((row) => row.labor_id === 11 && row.labor_grade > 0))
            const packets = station(f, id)
            assert.equal(f.state().home.builds.find((build) => build.guid === 20).station_pet_guid, f.worker(id))
            assert.equal(worker(f, id).capacity_id, 4002)
            assert.equal(worker(f, id).work_build, 20)
            const ack = packets.findIndex((packet) => packet.id === 6532)
            for (const sync of [6102, 6517])
                assert(
                    packets.findIndex((packet) => packet.id === sync) >= 0 &&
                        packets.findIndex((packet) => packet.id === sync) < ack,
                )
            station(f, id, { out_hub: true })
            assert.equal(worker(f, id).work_status, 0)
        }
    } finally {
        f.store.close()
    }
})

test('valid current artisan can replace the worker and retains queued outcomes and paid costs through cancellation', () => {
    const f = setup()
    try {
        station(f, 500181)
        f.call('ProductOrnamentStart', { ...request, count: 2 })
        const initial = structuredClone(jobs(f)),
            before = f.state(),
            petSatiety = before.pets.map((pet) => [pet.guid, pet.satiety_val])
        f.advance(10)
        station(f, 500185, { out_hub: true })
        assert.equal(worker(f, 500181).work_status, 0)
        assert.equal(worker(f, 500185).work_status, 2)
        const build = f.state().home.builds.find((row) => row.guid === 20)
        const expected = productionSeconds(tables, f.state(), build, {
            ...tables.find('accessory_product', 1),
            time: 60,
        })
        assert.equal(jobs(f)[0].seconds, expected)
        assert(Math.abs((f.now() - jobs(f)[0].start) / expected - 10 / initial[0].seconds) <= 1 / expected)
        assert.equal(jobs(f)[1].start, jobs(f)[0].start + expected)
        assert.deepEqual(
            jobs(f).map((job) => [job.guid, job.rewards, job.costs]),
            initial.map((job) => [job.guid, job.rewards, job.costs]),
        )
        const beforeCancel = f.state(),
            costs = initial[0].costs.filter((row) => row.itemtype === 3)
        f.call('ProductCancel', { guid: 20, is_all: true })
        for (const cost of costs)
            assert.equal(stock(f.state(), cost.itemid), stock(beforeCancel, cost.itemid) + 2 * cost.itemnum)
        assert.equal(jobs(f).length, 0)
        assert.equal(worker(f, 500185).work_status, 1)
        // Satiety debit timing remains a documented unresolved contract; this fix must not introduce a guessed debit.
        assert.deepEqual(
            f.state().pets.map((pet) => [pet.guid, pet.satiety_val]),
            petSatiety,
        )
        const settled = db(f)
        assert.throws(() => f.call('ProductCancel', { guid: 20, product_guids: [initial[0].guid] }))
        assert.deepEqual(db(f), settled)
    } finally {
        f.store.close()
    }
})

test('missing or malformed home size and unsupported size fail atomically before replacing current worker', () => {
    const f = setup(),
        find = tables.find
    try {
        station(f, 500181)
        for (const [replacement, code] of [
            [undefined, ErrorCode.PetHomeConfNotExist],
            [{ sizeType: '2' }, ErrorCode.GameConfig],
            [{ sizeType: 99 }, ErrorCode.GameConfig],
            [{ sizeType: 4 }, ErrorCode.InvalidArgument],
        ]) {
            tables.find = function (name, id) {
                return name === 'pet_home_talent' && id === 500185 ? replacement : find.call(this, name, id)
            }
            const before = db(f)
            assert.throws(() => station(f, 500185), error(code))
            assert.deepEqual(db(f), before)
            tables.find = find
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.pets.find((pet) => pet.guid === f.worker(500185)).labor_infos = [{ labor_id: 2, labor_grade: 20 }]
        })
        const before = db(f)
        assert.throws(() => station(f, 500185), error(ErrorCode.PetLaborNotMatch))
        assert.deepEqual(db(f), before)
    } finally {
        tables.find = find
        f.store.close()
    }
})

test('ACK codec failure cannot leak worker replacement, costs, timers or pet/build snapshots', () => {
    const f = setup(),
        encode = protocol.encode,
        entry = protocol.byName.get('CSProtoPetStationed')
    try {
        station(f, 500181)
        f.call('ProductOrnamentStart', request)
        f.advance(10)
        const before = db(f)
        protocol.encode = function (type, data) {
            if (type === entry.rsp) throw Error('artisan-codec-failure')
            return encode.call(this, type, data)
        }
        assert.throws(() => station(f, 500185), /artisan-codec-failure/)
        assert.deepEqual(db(f), before)
        protocol.encode = encode
        station(f, 500185)
        assert.equal(worker(f, 500185).work_build, 20)
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})

test('SQLite close and reopen retain the selected valid artisan and queued accessory outcome', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-artisan-size-')),
        filename = path.join(directory, 'test.sqlite')
    let f
    try {
        f = setup(filename)
        station(f, 500360)
        f.call('ProductOrnamentStart', request)
        const saved = structuredClone(jobs(f))
        f.store.close()
        f = setup(filename, false)
        assert.equal(worker(f, 500360).work_build, 20)
        assert.equal(f.state().home.builds.find((row) => row.guid === 20).station_pet_guid, f.worker(500360))
        assert.deepEqual(jobs(f), saved)
        station(f, 500360, { out_hub: true })
        assert.equal(worker(f, 500360).work_status, 0)
        assert.equal(f.state().home.builds.find((row) => row.guid === 20).station_pet_guid, '0')
    } finally {
        f?.store.close()
        const absolute = path.resolve(directory)
        assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
        assert(path.basename(absolute).startsWith('lurukaps-artisan-size-'))
        fs.rmSync(absolute, { recursive: true, force: true })
    }
})
