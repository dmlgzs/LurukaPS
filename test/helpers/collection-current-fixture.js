import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../../src/config.js'
import { Tables } from '../../src/player.js'
import { Protocol } from '../../src/protocol.js'
import { Store } from '../../src/store.js'
import { Game } from '../../src/game.js'
import { grantRewards, parseRewards } from '../../src/rewards.js'
import { ErrorCode } from '../../src/error-codes.js'
import { collectionPlan } from '../../src/home-collection.js'

// Historical writer-compatible serialized input, not an old runtime table/fallback.
// Orchard500001: old5% time trait, labor3 grade20 reduction791/10000, old periods36/2412/360.
const oldPeriods = [
    [131000101, 31.49478],
    [131000201, 31.49478],
    [136000101, 2110.1502600000003],
    [136000201, 2110.1502600000003],
    [136000301, 2110.1502600000003],
    [1300511450, 314.94780000000003],
]

function fixture(name, { filename = ':memory:' } = {}) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base)
    let store = new Store(filename),
        session = {}
    let now = 1800000000,
        sequence = 1
    const rng = (min, max) => (max === undefined ? 0 : min)
    let game = new Game(protocol, store, tables, { clock: () => now, rng })
    const request = (name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry)
        return {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, value) : Buffer.alloc(0),
        }
    }
    const call = (name, value, who = session) => game.dispatch(who, request(name, value))
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
        s.player.basic_info.lv = 30
        const exp = tables
            .get('home_level')
            .filter((row) => row.id < 4)
            .reduce((sum, row) => sum + row.exp, 0)
        grantRewards(tables, s, [{ itemtype: 10, itemid: 1003, itemnum: exp - Number(s.home.experienceTotal) }])
    })
    call('EnterHome')
    const build = state().home.builds.find((row) => row.build_id === 130011),
        worker = state().pets.find((row) => row.config_id === 500001)
    assert(build && worker)
    const hash = () =>
        createHash('sha256')
            .update(JSON.stringify(store.load(session.id)))
            .digest('hex')
    const disk = () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id)
    return {
        name,
        tables,
        protocol,
        get store() {
            return store
        },
        get session() {
            return session
        },
        get game() {
            return game
        },
        request,
        call,
        state,
        build,
        worker,
        hash,
        disk,
        assign: () =>
            call('PetStationed', { build_guid: build.guid, build_type: 1, sub_work_type: 0, pet_guid: worker.guid }),
        setTime: (value) => {
            now = value
        },
        reopen: () => {
            store.close()
            store = new Store(filename)
            session = {}
            game = new Game(protocol, store, tables, { clock: () => now, rng })
            return call('EnterGame', { open_id: name })
        },
        close: () => store.close(),
    }
}

function legacy(f, blocked = false, extraPeriods = []) {
    f.store.transact(f.session.id, 0, (s) => {
        const build = s.home.builds.find((row) => row.guid === f.build.guid),
            pet = s.pets.find((row) => row.guid === f.worker.guid)
        Object.assign(pet, {
            hero_id: '0',
            work_status: 2,
            work_build: build.guid,
            capacity_id: 2001,
            satiety_val: 100,
            talent_id: [20010110],
            labor_infos: [{ labor_id: 3, labor_grade: 20, upper_labor_grade: 40, labor_exp: 0 }],
        })
        build.station_pet_guid = pet.guid
        build.status = 4
        s.home.stationPets = [...new Set([...(s.home.stationPets ?? []), pet.guid])]
        const clocks = [...oldPeriods, ...extraPeriods].map(([product, seconds]) => ({
            product,
            seconds,
            next: 1800000000 + seconds,
        }))
        if (blocked) {
            for (const clock of clocks) clock.remaining = Math.max(0, (clock.next - clocks[0].next) / clock.seconds)
            clocks[0].pending = 1 // Already rolled single-candidate output; never recompute current7-unit quantity.
        }
        s.home.collectionProduction ??= {}
        s.home.collectionProduction[build.guid] = { pet: pet.guid, started: 1800000000, clocks, blocked }
        build.collect_build_data = {
            guid: build.guid,
            build_id: build.build_id,
            pet_guid: pet.guid,
            start_time: 1800000000,
            product_infos: clocks.map((clock) => ({
                product_id: clock.product,
                last_collect_time: 1800000000,
                next_collect_time: Math.ceil(clock.next),
            })),
            items: blocked
                ? [
                      {
                          item_id: 300000,
                          item_type: 3,
                          item_num: collectionPlan(f.tables, s, build).slots * 2000,
                          source_product_id: clocks[0].product,
                      },
                  ]
                : [],
        }
    })
    if (blocked) f.setTime(1800000032)
}

function extraSource(f, kind) {
    if (kind === 'technology') {
        f.store.transact(f.session.id, 0, (s) =>
            grantRewards(f.tables, s, [{ itemtype: 10, itemid: 205, itemnum: 10 }]),
        )
        f.call('HomeTechnologyTypeInfo', { type: 1 })
        const seen = new Set()
        const research = (id) => {
            if (f.state().home.technology?.levels?.[id]?.level > 0) return
            assert(!seen.has(id), 'Current research prerequisites must be acyclic')
            seen.add(id)
            const tree = f.tables.find('home_technology_tree', id)
            assert(tree)
            for (const parent of String(tree.pretechnologyTypeId ?? '')
                .split('|')
                .map(Number)
                .filter((id) => id > 0))
                research(parent)
            f.call('HomeTechnologyLevelUp', { type: tree.category, subType: id })
        }
        const row = f.tables.get('home_technology').find((row) => row.id === 1002001)
        assert.equal(row.buffId, '2029')
        assert.equal(row.buffParams, '139000001')
        research(row.type)
        assert.equal(f.state().home.technology.levels[row.type].level, row.level)
        // This extra existed in the old schema too, period360 under the same historical worker modifiers.
        return [[139000001, 314.94780000000003]]
    }
    const world = f.tables.get('home_collection_world').find((row) => row.id === 1)
    const building = f.tables
        .get('home_building_collection')
        .find((row) => row.groupId === world.groupId && row.level === 1)
    assert(building)
    f.store.transact(f.session.id, 0, (s) => grantRewards(f.tables, s, parseRewards(building.material)))
    f.call('CollectBuildCreate', { collect_id: world.id })
    assert.equal(f.state().home.worldCollections[world.id].build_id, building.id)
    // Historical10101/10102 both had period720;10103 adds one storage cell, accounted for in legacy().
    return [
        [131010101, 629.8956],
        [131010201, 629.8956],
    ]
}

function unchanged(f, run, predicate = (error) => error.code === ErrorCode.GameConfig) {
    const before = f.hash(),
        disk = f.disk()
    assert.throws(run, predicate)
    assert.equal(f.hash(), before)
    assert.deepEqual(f.disk(), disk)
}
export { fixture, legacy, oldPeriods, extraSource, unchanged }
