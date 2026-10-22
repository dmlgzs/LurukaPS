import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { productionSeconds, retimeProduction } from '../src/production-time.js'
import { refreshProduction } from '../src/production.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture() {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    call('EnterGame', { open_id: 'production-workers' })
    store.transact(session.id, 0, (state) => {
        state.world.map_id = 701
        state.player.basic_info.lv = 16
        for (const type of [11005, 22010, 22020]) state.home.technology.levels[type] = { level: 1, lastTime: 0 }
        state.home.builds.push(
            {
                guid: 18,
                build_id: 100011,
                build_type: 10,
                status: 1,
                locate: { block_id: 101, anchor: 6750237, direction: 0 },
            },
            {
                guid: 21,
                build_id: 20141,
                build_type: 2,
                status: 1,
                locate: { block_id: 101, anchor: 6750238, direction: 0 },
            },
        )
        const worker = state.pets[0]
        worker.labor_infos = [
            { labor_id: 1, labor_grade: 20 },
            { labor_id: 2, labor_grade: 20 },
        ]
        worker.talent_id = []
        worker.satiety_val = 10000
        worker.work_status = 0
        worker.work_build = 0
        worker.hero_id = '0'
        state.player.sbag_infos.items = [
            { itemid: 400101, itemnum: 30 },
            { itemid: 400301, itemnum: 30 },
            { itemid: 300000, itemnum: 30 },
        ]
    })
    return {
        store,
        call,
        session,
        worker: store.load(session.id).state.pets[0].guid,
        state: () => store.load(session.id).state,
        now: () => now,
        advance: (seconds) => {
            now += seconds
            return game
                .tick(session.id)
                .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
        },
        close: () => store.close(),
    }
}
const stock = (state, id) => state.player.sbag_infos.items.find((entry) => entry.itemid === id)?.itemnum ?? 0
const corn = { build_guid: 18, cook_id: 9000301, cook_count: 1, cook_material: [{ item_id: 400301, item_num: 6 }] }

test('stationing synchronizes worker/build and accelerates actual cooking, milling and ProductStart timers', () => {
    const f = fixture()
    try {
        const stationed = f.call('PetStationed', { pet_guid: f.worker, build_guid: 18, build_type: 1 })
        assert(
            stationed.some(
                (packet) =>
                    packet.id === 6102 &&
                    packet.data.home_builds.find((b) => b.guid === 18).station_pet_guid === f.worker,
            ),
        )
        assert(stationed.some((packet) => packet.id === 6517))
        assert.equal(f.state().pets[0].work_build, 18)
        f.call('CookRequest', corn)
        const seconds = Math.floor(
            tables.find('products', 9100301).time * (1 - tables.find('home_labor_efficiency', 20).TimeReduct / 10000),
        )
        assert.equal(seconds, 8)
        assert.equal(f.state().home.productionJobs[18][0].seconds, seconds)
        assert.equal(f.state().home.builds.find((b) => b.guid === 18).product[0].finish_time, f.now() + seconds)
        assert.equal(f.state().pets[0].work_status, 2)
        f.advance(seconds - 1)
        assert.throws(() => f.call('ProductFinish', { guid: 18, is_all: true }), /No finished/)
        const done = f.advance(1)
        assert(
            done.some(
                (p) => p.id === 6517 && p.data.pet_infos.pets.find((pet) => pet.guid === f.worker).work_status === 1,
            ),
        )
        f.call('ProductFinish', { guid: 18, is_all: true })
        assert.equal(stock(f.state(), 9000301), 1)
        f.call('PetStationed', { pet_guid: f.worker, build_guid: 21, source_build: 18, build_type: 1 })
        assert.equal(f.state().home.builds.find((b) => b.guid === 18).station_pet_guid, '0')
        f.call('CookRequest', {
            build_guid: 21,
            cook_id: 1400101,
            cook_count: 1,
            cook_material: [{ item_id: 400101, item_num: 3 }],
        })
        assert.equal(f.state().home.productionJobs[21][0].seconds, 2)
        f.advance(2)
        f.call('ProductFinish', { guid: 21, is_all: true })
        assert.equal(stock(f.state(), 1400101), 1)
        f.call('PetStationed', { pet_guid: f.worker, build_guid: 1, source_build: 21, build_type: 1 })
        f.call('ProductStart', { build_guid: 1, product_id: 302001, count: 1 })
        assert.equal(f.state().home.productionJobs[1][0].seconds, 2)
        f.advance(2)
        f.call('ProductFinish', { guid: 1, is_all: true })
        assert.equal(stock(f.state(), 350000), 1)
        f.call('PetStationInHomeHub', { pet_guid: f.worker, type: 1 })
        assert.equal(f.state().home.builds[0].station_pet_guid, '0')
        assert.equal(f.state().pets[0].work_status, 0)
    } finally {
        f.close()
    }
})

test('changing workers preserves completed units and current work, reorders waiting batches and avoids double grants', () => {
    const f = fixture()
    try {
        f.call('CookRequest', { ...corn, cook_count: 3 })
        f.call('CookRequest', corn)
        f.advance(15)
        f.call('PetStationed', { pet_guid: f.worker, build_guid: 18, build_type: 1 })
        let jobs = f.state().home.productionJobs[18]
        assert.equal(jobs[0].start, f.now() - 12) // 1.5 completed units at 8 seconds each.
        assert.equal(jobs[0].seconds, 8)
        assert.equal(jobs[1].start, jobs[0].start + 24)
        f.call('ProductFinish', { guid: 18, product_guids: [1] })
        assert.equal(stock(f.state(), 9000301), 1)
        f.advance(4)
        f.call('ProductFinish', { guid: 18, product_guids: [1] })
        assert.equal(stock(f.state(), 9000301), 2)
        f.call('PetStationed', { pet_guid: f.worker, build_guid: 18, build_type: 1 }) // Toggle off.
        assert.equal(f.state().pets[0].work_status, 7)
        jobs = f.state().home.productionJobs[18]
        assert.equal(jobs[0].seconds, 10)
        assert.equal(jobs[1].start, f.now() + 10)
        f.advance(10)
        f.call('ProductFinish', { guid: 18, product_guids: [1] })
        f.advance(10)
        f.call('ProductFinish', { guid: 18, product_guids: [2] })
        assert.equal(stock(f.state(), 9000301), 4)
        assert.throws(() => f.call('ProductFinish', { guid: 18, is_all: true }))
    } finally {
        f.close()
    }
})

test('labor grade, fatigue, station-specific talent, technology and minimum duration follow the tables', () => {
    const state = {
        home: { technology: { levels: {} } },
        pets: [{ guid: '1', satiety_val: 10000, talent_id: [], labor_infos: [{ labor_id: 2, labor_grade: 20 }] }],
    }
    const build = { build_id: 20071, build_type: 2, station_pet_guid: '1' },
        recipe = tables.find('products', 308001)
    assert.equal(productionSeconds(tables, state, build, recipe), Math.floor(6 * 0.8))
    state.pets[0].talent_id = [30040210] // Leather processing -12%.
    state.home.technology.levels[10030] = { level: 1 } // -9.09%.
    assert.equal(productionSeconds(tables, state, build, recipe), Math.floor(6 * (1 - 0.12 - 0.0909) * 0.8))
    state.pets[0].satiety_val = 10
    assert.equal(productionSeconds(tables, state, build, recipe), Math.floor(6 * (1 - 0.12 - 0.0909) * (1 - 0.2 * 0.4)))
    state.home.technology.levels = {}
    state.pets[0].talent_id = [30030110] // Furnace talent does not apply to leather processing.
    state.pets[0].labor_infos = [{ labor_id: 1, labor_grade: 100 }]
    assert.equal(productionSeconds(tables, state, build, recipe), 6)
    state.pets[0].satiety_val = 10000
    state.pets[0].labor_infos = [{ labor_id: 2, labor_grade: 100 }]
    assert.equal(
        productionSeconds(tables, state, build, recipe),
        Number(tables.get('game').find((r) => r.title === 'HOME_PROCESS_PRODUCT_TIME').value),
    )
})

test('unsupported dispatch, incompatible worker and stale source fail atomically; login repairs original-duration queues', () => {
    const f = fixture()
    try {
        for (const req of [
            { pet_guid: f.worker, build_guid: 18, build_type: 3 },
            { pet_guid: f.worker, build_guid: 999, build_type: 1 },
            { pet_guid: f.worker, build_guid: 18, build_type: 1, source_build: 99 },
        ]) {
            const before = f.state()
            assert.throws(() => f.call('PetStationed', req))
            assert.deepEqual(f.state(), before)
        }
        f.call('CookRequest', { ...corn, cook_count: 2 })
        f.advance(5)
        f.store.transact(f.session.id, 0, (state) => {
            state.home.builds.find((b) => b.guid === 18).station_pet_guid = f.worker
            state.pets[0].work_status = 2
            state.pets[0].work_build = 18
        })
        f.call('EnterGame', { open_id: 'production-workers', reconnect: true }, {})
        assert.equal(f.state().home.productionJobs[18][0].seconds, 8)
        assert.equal(f.state().home.productionJobs[18][0].start, f.now() - 4)
        f.advance(12)
        f.call('ProductFinish', { guid: 18, is_all: true })
        assert.equal(stock(f.state(), 9000301), 2)
        assert.equal(f.state().home.craftCounts[9100301], 2)
    } finally {
        f.close()
    }
})

test('retiming leaves completed batches and an unchanged ordinary hatch untouched', () => {
    const state = {
        pets: [],
        petEggs: [{ guid: 1, configid: 40003007, hatch_build_guid: 2 }],
        home: {
            builds: [
                { guid: 1, build_id: 10000, build_type: 2 },
                { guid: 2, build_id: 30231, build_type: 12 },
            ],
            productionJobs: {
                1: [{ productId: 302001, start: 100, seconds: 3, count: 1, claimed: 0 }],
                2: [{ kind: 'hatch', eggGuid: 1, productId: 710021, start: 104, seconds: 18000, count: 1, claimed: 0 }],
            },
        },
    }
    const before = structuredClone(state)
    assert.equal(retimeProduction(tables, state, 110), false)
    assert.deepEqual(state, before)
})

test('production refresh copies only a changed worker when deferred transactions share pets', () => {
    const worker = { guid: '1', work_build: 1, work_status: 2 },
        untouched = { guid: '2', work_status: 0 }
    const base = {
        pets: [worker, untouched],
        home: {
            builds: [{ guid: 1, station_pet_guid: '1', status: 4 }],
            productionJobs: { 1: [{ productId: 302001, start: 100, seconds: 2, count: 1, claimed: 0 }] },
        },
    }
    const draft = { ...structuredClone(base), pets: base.pets }
    refreshProduction(draft, 103)
    assert.equal(base.pets[0].work_status, 2)
    assert.equal(draft.pets[0].work_status, 1)
    assert.notEqual(draft.pets, base.pets)
    assert.equal(draft.pets[1], untouched)
})
