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
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const artisans = [500039, 500058, 500085, 500158, 500212, 500216, 500246, 500295, 500611, 500813, 500814]
const collectionWorkers = [500035, 500042, 500053, 500082]
function setup(file = ':memory:', initialize = true) {
    let now = 1800000000,
        seq = 1
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 }),
        session = {}
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'station-home-size' })
    if (initialize)
        store.transact(session.id, 0, (state) => {
            state.world.map_id = Number(tables.get('game').find((r) => r.title === 'HOME_ID').value)
            state.player.basic_info.lv = 45
            state.home.level = 30
            state.home.technology.levels[11010] = { level: 1, lastTime: 0 }
            for (const [guid, build_id, build_type] of [
                [20, 20201, 2],
                [21, 20271, 10],
                [22, 100011, 10],
                [23, 20041, 2],
            ])
                state.home.builds.push({
                    guid,
                    build_id,
                    build_type,
                    status: 1,
                    locate: { block_id: 101, anchor: 6750200 + guid, direction: 0 },
                })
            for (const [i, station] of tables.get('home_building_homecollection').entries())
                state.home.builds.push({
                    guid: 100 + i,
                    build_id: station.id,
                    build_type: 24,
                    status: 1,
                    locate: { block_id: 101, anchor: 6750300 + i, direction: 0 },
                })
            grantRewards(
                tables,
                state,
                [...new Set([...artisans, ...collectionWorkers])].map((itemid) => ({
                    itemtype: 5,
                    itemid,
                    itemnum: 1,
                })),
            )
            grantRewards(tables, state, [
                { itemtype: 3, itemid: 400301, itemnum: 1000 },
                ...parseRewards(tables.find('products', 304001).material).map((r) => ({
                    ...r,
                    itemnum: r.itemnum * 100,
                })),
            ])
        })
    const state = () => store.load(session.id).state
    const pet = (id) => state().pets.findLast((p) => p.config_id === id)
    const station = (id, guid, extra = {}) =>
        call('PetStationed', { pet_guid: id ? pet(id).guid : '0', build_guid: guid, build_type: 1, ...extra })
    return {
        store,
        game,
        session,
        call,
        state,
        pet,
        station,
        advance: (seconds) => {
            now += seconds
            return game.tick(session.id)
        },
        snapshot: () => ({
            state: state(),
            players: store.db.prepare('SELECT * FROM players').all(),
            requests: store.db.prepare('SELECT count(*) AS n FROM request_log').get(),
            pending: structuredClone([...store.pending]),
        }),
    }
}
const build = (f, guid) => f.state().home.builds.find((b) => b.guid === guid)
const jobs = (f, guid) => f.state().home.productionJobs[guid]
test('type2 and type10 accept all eleven actual home-size-qualified combat-body4/5 artisans and sync before ACK', () => {
    const f = setup()
    try {
        for (const guid of [20, 21])
            for (const id of artisans) {
                assert([2, 3].includes(tables.find('pet_home_talent', id).sizeType))
                assert([4, 5].includes(tables.find('pet', id).bodyType))
                assert(f.pet(id).labor_infos.some((r) => r.labor_id === 1 && r.labor_grade > 0))
                const packets = f.station(id, guid),
                    ack = packets.findIndex((p) => p.id === 6532)
                assert.equal(build(f, guid).station_pet_guid, f.pet(id).guid)
                assert.equal(f.pet(id).work_build, guid)
                for (const sync of [6102, 6517])
                    assert(
                        packets.findIndex((p) => p.id === sync) >= 0 && packets.findIndex((p) => p.id === sync) < ack,
                    )
                f.station(id, guid, { out_hub: true })
                assert.equal(f.pet(id).work_status, 0)
                assert.equal(build(f, guid).station_pet_guid, '0')
            }
    } finally {
        f.store.close()
    }
})
test('type24 actual body5 workers start each matching collection station without substituting orphan pet configurations', () => {
    const f = setup()
    try {
        for (const [guid, ids] of [
            [100, [500035, 500042, 500082]],
            [101, [500042, 500053, 500082]],
            [102, [500042, 500053, 500082]],
        ])
            for (const id of ids) {
                assert.equal(tables.find('pet', id).bodyType, 5)
                assert.equal(tables.find('pet_home_talent', id).sizeType, 3)
                f.station(id, guid)
                const b = build(f, guid),
                    station = tables.find('home_building_homecollection', b.build_id)
                assert.equal(f.pet(id).capacity_id, station.petCapacity)
                assert.equal(b.collect_build_data.pet_guid, f.pet(id).guid)
                assert.equal(b.collect_build_data.start_time, 1800000000)
                f.station(id, guid, { out_hub: true })
                assert.equal(build(f, guid).collect_build_data.start_time, 0)
            }
    } finally {
        f.store.close()
    }
})
test('missing, corrupt and genuinely oversized home configurations fail atomically before displacing the current worker', () => {
    const f = setup(),
        find = tables.find
    try {
        f.station(500039, 20)
        for (const [replacement, code] of [
            [undefined, ErrorCode.PetHomeConfNotExist],
            [{ sizeType: '2' }, ErrorCode.GameConfig],
            [{ sizeType: 99 }, ErrorCode.GameConfig],
            [{ sizeType: 4 }, ErrorCode.InvalidArgument],
        ]) {
            tables.find = function (name, id) {
                return name === 'pet_home_talent' && id === 500058 ? replacement : find.call(this, name, id)
            }
            const before = f.snapshot()
            assert.throws(
                () => f.station(500058, 20),
                (e) => e.code === code,
            )
            assert.deepEqual(f.snapshot(), before)
            tables.find = find
        }
    } finally {
        tables.find = find
        f.store.close()
    }
})
test('newly eligible cooking and ordinary production workers preserve queues and costs through swap, codec failure and cancellation', () => {
    const f = setup(),
        encode = protocol.encode,
        reply = protocol.byName.get('CSProtoPetStationed').rsp
    try {
        f.station(500039, 22)
        f.call('CookRequest', {
            build_guid: 22,
            cook_id: 9000301,
            cook_count: 2,
            cook_material: [{ item_id: 400301, item_num: 6 }],
        })
        const initial = structuredClone(jobs(f, 22))
        f.advance(1)
        const before = f.snapshot()
        protocol.encode = function (type, value) {
            if (type === reply) throw Error('size-swap-codec')
            return encode.call(this, type, value)
        }
        assert.throws(() => f.station(500058, 22, { out_hub: true }), /size-swap-codec/)
        assert.deepEqual(f.snapshot(), before)
        protocol.encode = encode
        f.station(500058, 22, { out_hub: true })
        assert.deepEqual(
            jobs(f, 22).map((j) => [j.guid, j.rewards, j.costs, j.count]),
            initial.map((j) => [j.guid, j.rewards, j.costs, j.count]),
        )
        f.call('ProductCancel', { guid: 22, is_all: true })
        const saved = f.snapshot()
        assert.throws(() => f.call('ProductCancel', { guid: 22, is_all: true }))
        assert.deepEqual(f.snapshot(), saved)
        f.station(500039, 23)
        f.call('ProductStart', { build_guid: 23, product_id: 304001, count: 2 })
        const regular = structuredClone(jobs(f, 23))
        f.station(500058, 23, { out_hub: true })
        assert.deepEqual(
            jobs(f, 23).map((j) => [j.guid, j.rewards, j.costs, j.count]),
            regular.map((j) => [j.guid, j.rewards, j.costs, j.count]),
        )
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})
test('a newly eligible worker and collection binding survive a full SQLite close and reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-station-size-')),
        filename = path.join(dir, 'test.sqlite')
    let f
    try {
        f = setup(filename)
        f.station(500035, 100)
        const saved = structuredClone(build(f, 100).collect_build_data),
            guid = f.pet(500035).guid
        f.store.close()
        f = setup(filename, false)
        assert.equal(build(f, 100).station_pet_guid, guid)
        assert.equal(f.pet(500035).work_build, 100)
        assert.deepEqual(build(f, 100).collect_build_data, saved)
        f.station(500035, 100, { out_hub: true })
        assert.equal(build(f, 100).station_pet_guid, '0')
    } finally {
        f?.store.close()
        const absolute = path.resolve(dir)
        assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
        assert(path.basename(absolute).startsWith('lurukaps-station-size-'))
        fs.rmSync(absolute, { recursive: true, force: true })
    }
})
