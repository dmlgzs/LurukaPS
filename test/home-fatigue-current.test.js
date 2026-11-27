import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { gridAnchor, validatePlacement } from '../src/home-grid.js'
import { collectionPlan } from '../src/home-collection.js'
import { ranchPetDrops, ranchSeconds } from '../src/ranch.js'
import { productionSeconds } from '../src/production-time.js'
import { productionTables } from '../src/production-tables.js'
import { settleProductionWork } from '../src/production-work.js'
import { workCompare } from '../src/production-work-fractions.js'
import policy from '../configs/production-work-policy.json' with { type: 'json' }
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    rng = (a, b) => (b === undefined ? 0 : a)
const constant = (key) => Number(tables.get('game').find((row) => row.title === key).value)
const threshold = constant('PET_HOME_TIRED_SATIETY')
function pure(kind, balance) {
    const s = seedPlayer(tables, 101, 'fatigue-pure'),
        p = createPets(tables, s, kind === 'collection' ? 500040 : kind === 'ranch' ? 500023 : 500043, 1, 1001, rng)[0]
    p.talent_id = []
    p.satiety_val = balance
    s.home = { builds: [], technology: { levels: {} }, productionJobs: {} }
    const b = {
        guid: 1,
        build_id: kind === 'collection' ? 130021 : 10000,
        build_type: kind === 'collection' ? 24 : 2,
        station_pet_guid: p.guid,
        status: 4,
        locate: {},
    }
    s.home.builds = [b]
    return { s, p, b }
}
for (const kind of ['collection', 'ranch', 'production'])
    test(`current Lua ${kind} quote uses full labor at equality and fatigue only below`, () => {
        assert.equal(threshold, 10)
        const values = []
        for (const balance of [threshold - 1, threshold, threshold + 1]) {
            const { s, p, b } = pure(kind, balance),
                fatigue =
                    balance < threshold
                        ? constant(
                              kind === 'collection'
                                  ? 'HOME_LABOR_GATHER_DECREASE'
                                  : kind === 'ranch'
                                    ? 'HOME_LABOR_PASTURE_DECREASE'
                                    : 'HOME_LABOR_PROCESS_DECREASE',
                          ) / 10000
                        : 1
            if (kind === 'collection') {
                const labor = p.labor_infos.find((r) => r.labor_id === 7),
                    eff = tables.find('home_labor_efficiency', labor.labor_grade).GatherTimeReduct / 10000
                const streams = collectionPlan(tables, s, b).streams
                assert(streams.some((row) => row.drop.dropTime > constant('HOME_PRODUCT_COLLECTION_BOTTOM_TIME')))
                for (const row of streams)
                    assert.equal(
                        row.seconds,
                        Math.max(
                            constant('HOME_PRODUCT_COLLECTION_BOTTOM_TIME'),
                            row.drop.dropTime * (1 - eff * fatigue),
                        ),
                    )
                values.push(Math.max(...streams.map((r) => r.seconds)))
            } else if (kind === 'ranch') {
                const labor = p.labor_infos.find((r) => r.labor_id === 9),
                    eff = tables.find('home_labor_efficiency', labor.labor_grade).PastureTimeReduct / 10000,
                    row = ranchPetDrops(tables, p)[0]
                const seconds = ranchSeconds(tables, s, p, row)
                assert.equal(seconds, Math.floor(row.dropTime * (1 - eff * fatigue)))
                values.push(seconds)
            } else {
                const labor = p.labor_infos.find((r) => r.labor_id === 2),
                    eff = tables.find('home_labor_efficiency', labor.labor_grade).TimeReduct / 10000,
                    recipe = productionTables(tables).find('products', 180010)
                const seconds = productionSeconds(productionTables(tables), s, b, recipe)
                assert.equal(
                    seconds,
                    Math.floor(Math.max(constant('HOME_PROCESS_PRODUCT_TIME'), recipe.time * (1 - eff * fatigue))),
                )
                values.push(seconds)
            }
        }
        assert(values[0] > values[1])
        assert.equal(values[1], values[2])
    })
function fixture(name, kind, balance, workPolicy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fatigue-current-')),
        file = path.join(dir, 'test.sqlite'),
        protocol = new Protocol(cfg.base)
    let store = new Store(file),
        session = {},
        seq = 1,
        now = 1800000000,
        game = new Game(protocol, store, tables, { clock: () => now, rng, productionWorkPolicy: workPolicy })
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: name })
    call('EnterHome')
    let worker, build
    store.transact(session.id, 0, (s) => {
        // Trusted current qualification, not a full story/technology earning replay.
        s.player.basic_info.lv = 30
        s.home.level = 30
        s.taskRecords = [...(s.taskRecords ?? []).filter((r) => r.task_id !== 106010), { task_id: 106010, count: 1 }]
        worker = createPets(
            tables,
            s,
            kind === 'collection' ? 500040 : kind === 'ranch' ? 500023 : 500043,
            1,
            1001,
            rng,
        )[0]
        worker.talent_id = []
        worker.satiety_val = balance
        if (kind === 'collection') grantRewards(tables, s, [{ itemtype: 13, itemid: 130021, itemnum: 1 }])
        if (kind === 'production') {
            s.home.technology.levels[33020] = { level: 1, lastTime: 0 }
            grantRewards(tables, s, parseRewards(tables.find('products', 180010).material))
        }
    })
    if (kind === 'collection') {
        const block = tables.find('home_block', 101),
            a = block.blockStartPos.split('|').map(Number),
            z = block.blockEndPos.split('|').map(Number)
        let locate
        for (let x = Math.min(a[0], z[0]); x < Math.max(a[0], z[0]) && !locate; x++)
            for (let y = Math.min(a[1], z[1]); y < Math.max(a[1], z[1]); y++) {
                const v = { block_id: 101, anchor: gridAnchor(x, y), direction: 0 }
                try {
                    validatePlacement(tables, state(), 130021, v)
                    locate = v
                    break
                } catch (e) {
                    if (!/overlaps|outside home block/.test(e.message)) throw e
                }
            }
        assert(locate)
        call('BuildLocate', { build_id: 130021, locate })
        build = state().home.builds.find((r) => r.build_id === 130021)
    } else if (kind === 'production') build = state().home.builds.find((r) => r.build_id === 10000)
    return {
        get store() {
            return store
        },
        get game() {
            return game
        },
        get session() {
            return session
        },
        worker,
        build,
        call,
        state,
        edit: (fn) => store.transact(session.id, 0, fn),
        now: () => now,
        advance: (t) => {
            now += t
            return game.tick(session.id)
        },
        reopen: () => {
            store.close()
            store = new Store(file)
            session = {}
            seq = 1
            game = new Game(protocol, store, tables, { clock: () => now, rng, productionWorkPolicy: workPolicy })
            return call('EnterGame', { open_id: name })
        },
        close: () => {
            store.close()
            fs.rmSync(dir, { recursive: true, force: true })
        },
    }
}
for (const kind of ['collection', 'ranch', 'production'])
    test(`real ${kind} dispatch 9/10/11 keeps stored output and cold clocks`, () => {
        const periods = []
        for (const balance of [threshold - 1, threshold, threshold + 1]) {
            const f = fixture(`fatigue-${kind}-${balance}`, kind, balance)
            try {
                if (kind === 'ranch')
                    f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: f.worker.guid, work_type: 1 })
                else f.call('PetStationed', { build_guid: f.build.guid, build_type: 1, pet_guid: f.worker.guid })
                if (kind === 'production')
                    f.call('ProductStart', { build_guid: f.build.guid, product_id: 180010, count: 1 })
                let period
                if (kind === 'collection')
                    period = Math.max(...f.state().home.collectionProduction[f.build.guid].clocks.map((r) => r.seconds))
                if (kind === 'ranch')
                    period = Math.min(...f.state().home.ranches[201].product_pets[0].drop_times.map((r) => r.seconds))
                if (kind === 'production') period = f.state().home.productionJobs[f.build.guid][0].seconds
                assert(period > 0)
                periods.push(period)
                f.advance(Math.ceil(period))
                const saved = structuredClone(f.state().home),
                    pet = structuredClone(f.state().pets.find((p) => p.guid === f.worker.guid))
                f.reopen()
                assert.deepEqual(f.state().pets.find((p) => p.guid === f.worker.guid).labor_infos, pet.labor_infos)
                // Reload does not manufacture a second completed item or rewrite its cadence.
                if (kind === 'production') assert.deepEqual(f.state().home.productionJobs, saved.productionJobs)
                if (kind === 'ranch') assert.deepEqual(f.state().home.ranches[201].drops, saved.ranches[201].drops)
                if (kind === 'collection')
                    assert.deepEqual(
                        f.state().home.builds.find((b) => b.guid === f.build.guid).collect_build_data.items,
                        saved.builds.find((b) => b.guid === f.build.guid).collect_build_data.items,
                    )
            } finally {
                f.close()
            }
        }
        assert(periods[0] > periods[1])
        assert.equal(periods[1], periods[2])
    })

test('local continuous-fee intervals retain exact threshold crossing, cadence independence and sealed outputs', () => {
    const { s, p, b } = pure('production', 11),
        recipes = productionTables(tables),
        recipe = recipes.find('products', 180010),
        t = 1800000000
    p.work_status = 2
    p.work_build = b.guid
    p.capacity_id = 4001
    const healthy = productionSeconds(recipes, s, b, recipe)
    s.home.productionJobs[1] = [
        { guid: 1, productId: recipe.id, count: 1, claimed: 0, start: t, seconds: healthy, costs: [], rewards: [] },
    ]
    settleProductionWork(tables, s, t, policy)
    const online = structuredClone(s),
        end = t + 100
    settleProductionWork(tables, s, t + healthy, policy)
    assert.equal(s.home.productionJobs[1][0].workCompleted, 0)
    assert(workCompare(s.home.productionWork.pets[p.guid].balance, threshold) < 0)
    settleProductionWork(tables, s, end, policy)
    for (let at = t + 1; at <= end; at++) settleProductionWork(tables, online, at, policy)
    assert.deepEqual(s, online)
    assert.equal(workCompare(s.home.productionWork.stats.spent, recipe.satietyScore), 0)
    const sealed = structuredClone(s.home.productionJobs[1][0])
    settleProductionWork(tables, s, end + 10000, policy)
    assert.deepEqual(s.home.productionJobs[1][0], sealed)
})

for (const kind of ['collection', 'ranch', 'production'])
    test(kind + ' failed assignment rolls back clocks, raw assets and SQLite', () => {
        const f = fixture('fatigue-rollback-' + kind, kind, threshold)
        try {
            const request = () =>
                kind === 'ranch'
                    ? f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: f.worker.guid, work_type: 1 })
                    : f.call('PetStationed', { build_guid: f.build.guid, build_type: 1, pet_guid: f.worker.guid })
            const before = structuredClone(f.store.load(f.session.id)),
                disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                encode = f.game.protocol.encode.bind(f.game.protocol)
            f.game.protocol.encode = (name, value) => {
                if (name.endsWith('SCHomeSync')) throw Error('fatigue codec')
                return encode(name, value)
            }
            assert.throws(request, /fatigue codec/)
            assert.deepEqual(f.store.load(f.session.id), before)
            f.game.protocol.encode = encode
            f.store.db.exec(
                "CREATE TEMP TRIGGER fatigue_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'fatigue SQL'); END",
            )
            assert.throws(request, /fatigue SQL/)
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                disk,
            )
            f.store.db.exec('DROP TRIGGER fatigue_fail')
            request()
        } finally {
            f.close()
        }
    })

for (const kind of ['collection', 'ranch', 'production'])
    test(kind + ' retimes only remaining progress and does not add prior output at equality', () => {
        const f = fixture('fatigue-retime-' + kind, kind, threshold - 1)
        try {
            if (kind === 'ranch')
                f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: f.worker.guid, work_type: 1 })
            else f.call('PetStationed', { build_guid: f.build.guid, build_type: 1, pet_guid: f.worker.guid })
            if (kind === 'production') {
                f.edit((s) => grantRewards(tables, s, parseRewards(tables.find('products', 180010).material)))
                f.call('ProductStart', { build_guid: f.build.guid, product_id: 180010, count: 2 })
            }
            const read = () =>
                kind === 'collection'
                    ? f.state().home.collectionProduction[f.build.guid].clocks
                    : kind === 'ranch'
                      ? f.state().home.ranches[201].product_pets[0].drop_times
                      : f.state().home.productionJobs[f.build.guid]
            const old = read(),
                period = Math.max(...old.map((r) => r.seconds))
            f.advance(Math.floor(period * 1.25))
            const before = structuredClone(read()),
                saved = structuredClone(f.state().home),
                at = f.now()
            f.edit((s) => {
                s.pets.find((p) => p.guid === f.worker.guid).satiety_val = threshold
            })
            f.call('HomeTechnologyTypeInfo', { type: 2 })
            const after = read()
            assert(before.some((r, i) => r.seconds > after[i].seconds))
            if (kind === 'production') {
                assert.equal(
                    after[0].start,
                    Math.ceil(at - ((at - before[0].start) / before[0].seconds) * after[0].seconds),
                )
                assert.equal(after[0].count, before[0].count)
                assert.deepEqual(after[0].rewards, before[0].rewards)
            } else
                for (let i = 0; i < before.length; i++) {
                    const a = before[i],
                        b = after[i]
                    if (kind === 'collection')
                        assert(Math.abs(b.next - (at + ((a.next - at) / a.seconds) * b.seconds)) < 1e-6)
                    else assert.equal(b.time, at + Math.max(1, Math.ceil(((a.time - at) / a.seconds) * b.seconds)))
                }
            if (kind === 'ranch') assert.deepEqual(f.state().home.ranches[201].drops, saved.ranches[201].drops)
            if (kind === 'collection')
                assert.deepEqual(
                    f.state().home.builds.find((b) => b.guid === f.build.guid).collect_build_data.items,
                    saved.builds.find((b) => b.guid === f.build.guid).collect_build_data.items,
                )
        } finally {
            f.close()
        }
    })

test('actual enabled continuous-policy Game crosses10, charges one budget and seals one reward across cold reopen', () => {
    const f = fixture('fatigue-enabled-policy', 'production', threshold + 1, policy)
    try {
        f.call('PetStationed', { build_guid: f.build.guid, build_type: 1, pet_guid: f.worker.guid })
        const at = f.now()
        f.call('ProductStart', { build_guid: f.build.guid, product_id: 180010, count: 1 })
        const before = structuredClone(f.state().home.productionJobs[f.build.guid][0])
        f.advance(before.seconds)
        const partial = f.state().home.productionJobs[f.build.guid][0]
        assert.equal(partial.workCompleted, 0)
        assert(workCompare(f.state().home.productionWork.pets[f.worker.guid].balance, threshold) < 0)
        f.advance(100)
        const ledger = f.state().home.productionWork,
            done = f.state().home.productionJobs[f.build.guid][0]
        assert.equal(done.workCompleted, 1)
        assert.equal(workCompare(ledger.stats.spent, 5), 0)
        assert.equal(workCompare(ledger.pets[f.worker.guid].balance, 6), 0)
        assert(done.workProjection.finish_time > at + before.seconds)
        const sealed = structuredClone(done),
            spent = structuredClone(ledger.stats.spent),
            encode = f.game.protocol.encode.bind(f.game.protocol),
            response = f.game.protocol.byName.get('CSProtoProductFinish').rsp
        const stock = () =>
                f
                    .state()
                    .player.sbag_infos.items.filter((r) => r.itemid === 1800007)
                    .reduce((n, r) => n + r.itemnum, 0),
            stockBefore = stock()
        f.game.protocol.encode = (name, value) => {
            if (name === response) throw Error('claim codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('ProductFinish', { guid: f.build.guid, is_all: true }), /claim codec/)
        assert.equal(stock(), stockBefore)
        assert.deepEqual(f.state().home.productionJobs[f.build.guid][0], sealed)
        f.game.protocol.encode = encode
        f.call('ProductFinish', { guid: f.build.guid, is_all: true })
        assert.equal(stock(), stockBefore + 1)
        f.reopen()
        assert.equal(stock(), stockBefore + 1)
        assert.deepEqual(f.state().home.productionWork.stats.spent, spent)
    } finally {
        f.close()
    }
})
