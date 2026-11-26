import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { createPets } from '../src/pets.js'
import { gridAnchor, validatePlacement } from '../src/home-grid.js'
import { collectionPlan } from '../src/home-collection.js'
import { worldCollectionConfiguration } from '../src/world-collection.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(name) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, {
        clock: () => now,
        rng: (min, max) => (max === undefined ? 0 : min),
    })
    // Explicit qualified prior chapter baseline, not a replay of the tutorial.
    // No world collection, production work, stock or claim is inserted.
    store.login(name, (id, openId) => {
        const s = seedPlayer(tables, id, openId),
            prior = new Set(),
            levels = []
        function visit(taskId) {
            if (prior.has(taskId)) return
            prior.add(taskId)
            const row = tables.find('task', taskId)
            assert(row)
            for (const part of String(row.unlockcondition).split('|')) {
                const [kind, value] = part.split('#').map(Number)
                if (kind === 2007) visit(value)
                if (kind === 2004) levels.push(value)
            }
        }
        visit(106010)
        s.taskRecords = [...prior].map((task_id) => ({ task_id, count: 1, time: 1 }))
        s.player.basic_info.lv = Math.max(s.player.basic_info.lv, ...levels)
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 10001)))
        return s
    })
    const call = (name, data = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: row.id,
            seq: seq++,
            payload: row.req ? protocol.encode(row.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    call('EnterHome')
    let worker
    edit((s) => {
        // A real owned grant is the independent acquisition baseline. Placement,
        // repair, dispatch, production and claim all use public Game requests.
        grantRewards(tables, s, [{ itemtype: 13, itemid: 130021, itemnum: 1 }])
        worker = createPets(tables, s, 500040, 1)[0]
        assert(worker.labor_infos.some((row) => row.labor_id === 7 && row.labor_grade > 0))
    })
    const block = tables.find('home_block', 101),
        start = block.blockStartPos.split('|').map(Number),
        end = block.blockEndPos.split('|').map(Number)
    let locate
    for (let x = Math.min(start[0], end[0]); x < Math.max(start[0], end[0]) && !locate; x++)
        for (let y = Math.min(start[1], end[1]); y < Math.max(start[1], end[1]); y++) {
            const value = { block_id: block.id, anchor: gridAnchor(x, y), direction: 0 }
            try {
                validatePlacement(tables, state(), 130021, value)
                locate = value
                break
            } catch (error) {
                if (!/overlaps|outside home block/.test(error.message)) throw error
            }
        }
    assert(locate)
    call('BuildLocate', { build_id: 130021, locate })
    const build = () => state().home.builds.find((row) => row.build_id === 130021)
    return {
        protocol,
        store,
        game,
        call,
        state,
        edit,
        worker,
        build,
        now: () => now,
        repair: (id) => {
            const rule = worldCollectionConfiguration(tables, id)
            edit((s) => grantRewards(tables, s, parseRewards(rule.building.material)))
            return call('CollectBuildCreate', { collect_id: id })
        },
        dispatch: () => call('PetStationed', { build_guid: build().guid, build_type: 1, pet_guid: worker.guid }),
        advance: (seconds) => {
            now += seconds
            return game.tick(session.id)
        },
        reload: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        sql: () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
    }
}
const quantity = (state, id) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((n, row) => n + row.itemnum, 0)

test('current world2 repair enables selected mining plan through real placement, dispatch, tick, claim and reconnect', () => {
    const f = fixture('current-world-plan2036')
    try {
        const initial = collectionPlan(tables, f.state(), f.build())
        assert(!initial.streams.some((row) => row.product === 133010101))
        const packets = f.repair(2)
        assert(packets.some((row) => row.id === 6526))
        const point = f.state().home.worldCollections[2]
        assert.equal(point.build_id, worldCollectionConfiguration(tables, 2).building.id)
        assert.equal(point.pet_guid, '0')
        assert.equal(point.start_time, 0)
        assert(!f.state().home.collectionProduction?.[point.guid])
        f.dispatch()
        const plan = collectionPlan(tables, f.state(), f.build()),
            stream = plan.streams.find((row) => row.product === 133010101)
        assert(stream)
        assert.equal(plan.planId, 13002101)
        assert.equal(f.build().collect_build_data.product_choose_id, plan.planId)
        f.advance(Math.ceil(stream.seconds))
        const stock = f.build().collect_build_data.items.find((row) => row.source_product_id === stream.product)
        assert.equal(stock.item_type, stream.drop.itemType)
        assert.equal(stock.item_id, stream.itemIds[0])
        assert.equal(stock.item_num, stream.drop.minValue)
        const before = quantity(f.state(), stock.item_id)
        const out = f.call('CollectGetReward', { guid: [f.build().guid] })
        const response = f.protocol.decode(
            f.protocol.byName.get('CSProtoCollectGetReward').rsp,
            out.find((row) => row.id === 6529).payload,
        )
        const reward = response.rewards
            .filter((row) => row.itemtype === stock.item_type && row.itemid === stock.item_id)
            .reduce((n, row) => n + row.itemnum, 0)
        assert(reward >= stock.item_num)
        assert.equal(quantity(f.state(), stock.item_id) - before, reward)
        assert.deepEqual(f.build().collect_build_data.items, [])
        const saved = structuredClone(f.state().home.worldCollections),
            pet = structuredClone(f.state().pets.find((row) => row.guid === f.worker.guid))
        f.reload()
        assert.deepEqual(f.state().home.worldCollections, saved)
        assert.deepEqual(f.state().pets.find((row) => row.guid === pet.guid).labor_infos, pet.labor_infos)
        assert.equal(f.build().station_pet_guid, pet.guid)
        assert.deepEqual(f.build().collect_build_data.items, [])
    } finally {
        f.store.close()
    }
})

function configurationState(worldIds) {
    return {
        pets: [],
        home: {
            worldCollections: Object.fromEntries(
                worldIds.map((id) => {
                    const rule = worldCollectionConfiguration(tables, id)
                    return [id, { guid: 1000 + id, collect_id: id, build_id: rule.building.id }]
                }),
            ),
        },
    }
}
const buildFor = (id = 130021) => ({ build_id: id, build_type: 24 })
function buffView(change) {
    return {
        get: (name) =>
            name === 'home_buff_params'
                ? tables.get(name).map((row) => (row.id === 30101 ? change(structuredClone(row)) : row))
                : tables.get(name),
        find: tables.find.bind(tables),
    }
}

test('all current world bonuses compile across every station and all fifteen2036 rows apply only to their declared current plan', () => {
    const worlds = tables.get('home_collection_world'),
        stations = tables.get('home_building_homecollection')
    const all = configurationState(worlds.map((row) => row.id))
    assert.equal(worlds.length, 36)
    assert(worlds.every((row) => row.type === 1))
    assert.equal(stations.length, 8)
    const rows = tables.get('home_buff_params').filter((row) => String(row.buffCondition).startsWith('2036#'))
    assert.equal(rows.length, 15)
    for (const station of stations) {
        const plan = collectionPlan(tables, all, buildFor(station.id))
        assert.equal(plan.planId, Number(station.planID))
        for (const row of rows) {
            const targetPlan = Number(row.buffCondition.split('#')[1]),
                product = Number(row.buffParams)
            assert.equal(
                plan.streams.some((stream) => stream.product === product),
                targetPlan === plan.planId,
            )
        }
        for (const world of worlds) collectionPlan(tables, configurationState([world.id]), buildFor(station.id))
    }
})

test('current plan gate, product target and condition logic preserve scope; unknown or malformed conditions cannot hide behind OR', () => {
    const state = configurationState([2]),
        base = collectionPlan(tables, configurationState([]), buildFor())
    const wrongPlan = buffView((row) => ({ ...row, buffCondition: '2034#13002|2036#13006101' }))
    assert(!collectionPlan(wrongPlan, state, buildFor()).streams.some((stream) => stream.product === 133010101))
    const rightPlan = buffView((row) => ({ ...row, buffCondition: '2034#13002|2036#13002101' }))
    assert(collectionPlan(rightPlan, state, buildFor()).streams.some((stream) => stream.product === 133010101))
    const floor = Number(tables.get('game').find((row) => row.title === 'HOME_PRODUCT_COLLECTION_BOTTOM_TIME').value)
    const target = base.streams.find((stream) => stream.seconds * 0.9 > floor)
    assert(target, 'the product-specific control must not be masked by the production floor')
    const productTime = buffView((row) => ({
        ...row,
        buffId: '2001',
        buffParams: '1000',
        buffCondition: `2012#${target.product}|2034#13002`,
        buffConditionLogic: 1,
    }))
    const reduced = collectionPlan(productTime, state, buildFor())
    for (const stream of base.streams)
        assert.equal(
            reduced.streams.find((row) => row.product === stream.product).seconds,
            stream.seconds * (stream.product === target.product ? 0.9 : 1),
        )
    for (const [condition, logic, code] of [
        ['2034#13002|999999#1', 2, ErrorCode.FunctionClosed],
        ['2036#bad', 2, ErrorCode.GameConfig],
        ['2036#13002101#1', 2, ErrorCode.GameConfig],
        ['2036#13002101', 0, ErrorCode.GameConfig],
    ]) {
        const view = buffView((row) => ({ ...row, buffCondition: condition, buffConditionLogic: logic }))
        assert.throws(() => collectionPlan(view, state, buildFor()), { code })
    }
    const invalid = buildFor()
    invalid.collect_build_data = { product_choose_id: 13006101 }
    assert.throws(() => collectionPlan(tables, state, invalid), { code: ErrorCode.GameConfig })
})

test('real repair, dispatch and claim codec failures roll back source unlock, jobs, pets, stock, payment and SQL', () => {
    const f = fixture('current-world-plan2036-rollback'),
        encode = f.protocol.encode
    const failure = (name, run) => {
        const before = f.state(),
            sql = f.sql(),
            response = f.protocol.byName.get('CSProto' + name).rsp
        f.protocol.encode = function (type, ...args) {
            if (type === response) throw Error('world-plan-codec-' + name)
            return encode.call(this, type, ...args)
        }
        try {
            assert.throws(run, new RegExp('world-plan-codec-' + name))
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.sql(), sql)
    }
    try {
        f.edit((s) => grantRewards(tables, s, parseRewards(worldCollectionConfiguration(tables, 2).building.material)))
        failure('HomeSync', () => f.call('CollectBuildCreate', { collect_id: 2 }))
        assert.equal(f.state().home.worldCollections?.[2], undefined)
        f.call('CollectBuildCreate', { collect_id: 2 })
        failure('HomeSync', f.dispatch)
        assert.equal(f.build().station_pet_guid ?? '0', '0')
        f.dispatch()
        const stream = collectionPlan(tables, f.state(), f.build()).streams.find((row) => row.product === 133010101)
        f.advance(Math.ceil(stream.seconds))
        assert(f.build().collect_build_data.items.some((row) => row.source_product_id === stream.product))
        failure('CollectGetReward', () => f.call('CollectGetReward', { guid: [f.build().guid] }))
        f.call('CollectGetReward', { guid: [f.build().guid] })
        assert.deepEqual(f.build().collect_build_data.items, [])
        assert.throws(() => f.call('CollectGetReward', { guid: [f.build().guid] }), {
            code: ErrorCode.CollectRewardNull,
        })
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
