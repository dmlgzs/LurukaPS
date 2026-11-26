import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { Protocol } from '../src/protocol.js'
import { ensureHome } from '../src/home.js'
import { ErrorCode } from '../src/error-codes.js'
import { cookingRecipe, cookingSelection, cookingOutcomes, qualityProductionRecipe } from '../src/cooking.js'
import { productionJobOutput } from '../src/production-output.js'
import { registerCooking } from '../src/handlers/cooking.js'
import { registerProduction } from '../src/handlers/production.js'
import { cookingVarietyValue } from '../src/production-progress.js'

const tables = new Tables(configuration().tables)
const materials = (recipe, grades = []) =>
    recipe.requirements.map((row, index) => ({
        item_id: [...row.grades].find(([, grade]) => grade === (grades[index] ?? 1))?.[0] ?? row.choices[0],
        item_num: row.count,
    }))
const code = (expected) => (error) => error.code === expected

function fixture(configId = 1002, grades = [1, 2], count = 3) {
    const store = new Store(':memory:'),
        handlers = new Map(),
        pushed = []
    registerCooking((name, handler) => handlers.set(name, handler), tables)
    registerProduction((name, handler) => handlers.set(name, handler), tables)
    const recipe = cookingRecipe(tables, configId),
        selected = materials(recipe, grades)
    const login = store.login('current-cooking', (id, openId) => seedPlayer(tables, id, openId))
    let now = 1800000000,
        draws = 0
    const rolls = [0, 11, 0]
    store.transact(login.id, 0, (state) => {
        const home = ensureHome(tables, state)
        const station = tables
            .get('home_building_production')
            .find((row) => recipe.product.group.split('|').map(Number).includes(row.groupId))
        const building = tables.find('home_building', station.id)
        home.builds = [
            {
                guid: 18,
                build_id: station.id,
                build_type: tables.get('home_building_group').find((row) => row.groupId === building.groupId).type,
                status: 1,
                locate: { block_id: 101, anchor: 6750237, direction: 0 },
                product: [],
            },
        ]
        home.technology = { levels: {}, spent: 0 }
        for (const token of recipe.product.unlockCondition.split('|').filter(Boolean)) {
            const [kind, id, level] = token.split('#').map(Number)
            if (kind === 11012) home.technology.levels[id] = { level, lastTime: 0, isOpened: true }
            else if (kind === 61001) (state.reputations ??= {})[id] = { level }
            else assert.fail('Unproven cooking prerequisite ' + token)
        }
        state.player.sbag_infos.items = selected.map((item, index) => ({
            itemid: item.item_id,
            itemnum: item.item_num * count,
            itemtype: 3,
            guid: String(index + 1),
        }))
    })
    const request = { build_guid: 18, cook_id: configId, cook_count: count, cook_material: selected }
    return {
        store,
        recipe,
        selected,
        request,
        draws: () => draws,
        state: () => store.load(login.id).state,
        edit: (callback) => store.transact(login.id, 0, callback),
        advance: (seconds) => {
            now += seconds
        },
        call: (name, data = request, requestKey = null) =>
            store.transact(login.id, 0, (state) =>
                handlers.get(name)(
                    {
                        state,
                        tables,
                        requestKey,
                        now,
                        push: (...args) => pushed.push(args),
                        randomInt: (max) => {
                            const value = rolls[draws++ % rolls.length]
                            return value % max
                        },
                    },
                    data,
                ),
            ),
        pushed,
    }
}
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((sum, row) => sum + row.itemnum, 0)

test('all 55 current groups and 255 grade variants validate from fresh tables without old needMaterial fields', () => {
    let variants = 0,
        zero = 0
    for (const row of tables.get('products_multi_quality')) {
        const recipe = cookingRecipe(tables, row.id)
        for (const [grade, variant] of recipe.variants) {
            variants++
            const selected = materials(
                recipe,
                recipe.requirements.map((requirement) => (requirement.calculate ? grade : 1)),
            )
            const choice = cookingSelection(recipe, selected)
            assert.equal(choice.baseGrade, grade)
            assert.equal(choice.remainder, 0)
            assert.equal(qualityProductionRecipe(tables, variant.product.id), true)
            const outcomes = cookingOutcomes(recipe, choice, 1, () => assert.fail('integer grade must not draw'))
            assert.equal(outcomes[0].productId, variant.product.id)
            assert.equal(variant.product.rewardId, `3#${outcomes[0].rewards[0].itemid}#1`)
            if (!grade) zero++
        }
    }
    assert.equal(variants, 255)
    assert.equal(zero, 5)
    assert.throws(() => cookingRecipe(tables, 9000301), code(ErrorCode.CookConfFail))
})

test('only calculating groups contribute quality; per-slot amount/order and complete materials are enforced', () => {
    const recipe = cookingRecipe(tables, 1006),
        selected = materials(recipe, [4, 1, 1])
    const choice = cookingSelection(recipe, selected)
    assert.equal(choice.baseGrade, 4)
    assert.equal(choice.remainder, 0)
    assert.throws(() => cookingSelection(recipe, []), code(ErrorCode.CookMaterialsNone))
    assert.throws(() => cookingSelection(recipe, selected.slice(1)), code(ErrorCode.CookMaterialNumNotMatch))
    assert.throws(
        () =>
            cookingSelection(
                recipe,
                selected.map((item, index) => (index ? item : { ...item, item_num: item.item_num + 1 })),
            ),
        code(ErrorCode.CookMaterialNumFail),
    )
    assert.throws(
        () => cookingSelection(recipe, [selected[1], selected[0], selected[2]]),
        code(ErrorCode.CookMaterialNumFail),
    )
    assert.throws(
        () =>
            cookingSelection(
                recipe,
                selected.map((item, index) => (index ? item : { ...item, item_id: 300000 })),
            ),
        code(ErrorCode.CookMaterialFail),
    )
})

test('fraction independently samples adjacent grades and sealed outcomes survive partial claims, cancel and serialization', () => {
    const f = fixture()
    try {
        const result = f.call('CookRequest')
        assert.deepEqual(result.rewards, [])
        assert.equal(f.draws(), 3)
        let state = f.state(),
            job = state.home.productionJobs[18][0]
        assert.deepEqual(
            job.cookingUnits.map((unit) => unit.grade),
            [2, 1, 2],
        )
        for (const item of f.selected) assert.equal(stock(state, item.item_id), 0)
        assert(f.pushed.some(([name]) => name === 'CSProtoSyncPlayerData'))
        f.advance(job.seconds)
        const claimed = f.call('ProductFinish', { guid: 18, product_guids: [job.guid] })
        assert.equal(claimed.reward.rewards[0].itemid, 9000202)
        state = f.state()
        assert.equal(state.home.craftCounts[9100202], 1)
        assert.equal(state.home.productionProgress.counts['10:3:9000202'], 1)
        assert.equal(state.home.productionJobs[18][0].claimed, 1)
        const reloaded = JSON.parse(JSON.stringify(state))
        assert.deepEqual(
            productionJobOutput(reloaded.home.productionJobs[18][0], 1, 2).rewards.map((item) => item.itemid),
            [9000201, 9000202],
        )
        f.advance(job.seconds)
        f.call('ProductCancel', { guid: 18, product_guids: [job.guid] })
        state = f.state()
        assert.equal(stock(state, 9000202), 1)
        assert.equal(stock(state, 9000201), 1)
        assert.equal(state.home.craftCounts[9100201], 1)
        assert.equal(state.home.productionProgress.counts['10:3:9000201'], 1)
        for (const item of f.selected) assert.equal(stock(state, item.item_id), item.item_num)
        assert.deepEqual(state.home.productionJobs[18], [])
        assert.equal(f.draws(), 3, 'claims and cancellations never reroll')
        const before = f.state()
        assert.throws(() => f.call('ProductFinish', { guid: 18, product_guids: [job.guid] }))
        assert.deepEqual(f.state(), before, 'duplicate claim is atomic')
    } finally {
        f.store.close()
    }
})

test('missing materials and quality ProductStart reject without costs, jobs or RNG draws', () => {
    const f = fixture()
    try {
        f.edit((state) => {
            state.player.sbag_infos.items[0].itemnum--
        })
        const before = f.state()
        assert.throws(() => f.call('CookRequest'), code(ErrorCode.ItemNotEnough))
        assert.deepEqual(f.state(), before)
        assert.equal(f.draws(), 0)
        assert.throws(
            () => f.call('ProductStart', { build_guid: 18, product_id: f.recipe.product.id, count: 1 }),
            /requires CookRequest/,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(f.draws(), 0)
    } finally {
        f.store.close()
    }
})

test('accepted request retransmission keeps the original job and outcomes without another charge or roll', () => {
    const f = fixture()
    try {
        f.call('CookRequest', f.request, 'session:10201:1')
        const before = f.state(),
            draws = f.draws()
        f.call('CookRequest', f.request, 'session:10201:1')
        assert.deepEqual(f.state(), before)
        assert.equal(f.draws(), draws)
        assert.throws(
            () => f.call('CookRequest', { ...f.request, cook_count: 2 }, 'session:10201:1'),
            code(ErrorCode.InvalidPacket),
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('grade0 recipe enqueues and produces its configured actual food without a random draw', () => {
    const f = fixture(1050, [], 2)
    try {
        f.call('CookRequest')
        const job = f.state().home.productionJobs[18][0]
        assert.equal(f.draws(), 0)
        assert.deepEqual(
            job.cookingUnits.map((unit) => unit.grade),
            [0, 0],
        )
        f.advance(job.seconds * 2)
        const result = f.call('ProductFinish', { guid: 18, is_all: true })
        assert.equal(
            result.reward.rewards.reduce((sum, row) => sum + row.itemnum, 0),
            2,
        )
        assert.equal(stock(f.state(), job.cookingUnits[0].rewards[0].itemid), 2)
    } finally {
        f.store.close()
    }
})

test('all six quality-selectable processing recipes spend actual ingredients and grant configured mill outputs', () => {
    const ids = tables
        .get('products_multi_quality')
        .map((row) => row.id)
        .filter((id) => cookingRecipe(tables, id).product.type === 2)
    assert.equal(ids.length, 6)
    for (const id of ids) {
        const f = fixture(id, [3], 2)
        try {
            f.call('CookRequest')
            const job = f.state().home.productionJobs[18][0]
            f.advance(job.seconds * 2)
            f.call('ProductFinish', { guid: 18, is_all: true })
            assert.equal(stock(f.state(), job.cookingUnits[0].rewards[0].itemid), 2)
            assert.equal(cookingVarietyValue(tables, f.state(), [12210, 30]), 0)
        } finally {
            f.store.close()
        }
    }
})

test('a missing adjacent quality rejects the fractional recipe without manufacturing a grade', () => {
    const recipe = cookingRecipe(tables, 1002),
        broken = { ...recipe, variants: new Map([[1, recipe.variants.get(1)]]) }
    assert.throws(() => cookingSelection(broken, materials(recipe, [1, 2])), code(ErrorCode.GameConfig))
})

test('historical homogeneous jobs retain sealed outputs without reroll or old-table lookup', () => {
    const job = { kind: 'cook', productId: 123, count: 4, rewards: [{ itemtype: 3, itemid: 9000101, itemnum: 1 }] }
    assert.deepEqual(productionJobOutput(job, 1, 2), {
        rewards: [{ itemtype: 3, itemid: 9000101, itemnum: 2 }],
        productCounts: new Map([[123, 2]]),
    })
    assert.throws(() => productionJobOutput({ ...job, cookingUnits: [] }, 0, 1), code(ErrorCode.GameConfig))
})

test('current wire request synchronizes queue and bag, survives scene exit and relogin, then claims sealed grades', () => {
    const f = fixture(),
        protocol = new Protocol(configuration().base),
        session = {}
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, f.store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, data, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    try {
        call('EnterGame', { open_id: 'current-cooking' })
        const returnPoint = { map_id: f.state().world.map_id, point_id: f.state().world.point_id }
        call('EnterHome', {})
        const packets = call('CookRequest', f.request),
            state = f.state(),
            job = state.home.productionJobs[18][0]
        assert(packets.some((packet) => packet.id === 10201))
        assert(
            packets.some(
                (packet) => packet.id === protocol.byName.get('CSProtoSyncPlayerData').id && packet.data.sbag_infos,
            ),
        )
        const home = packets.find((packet) => packet.id === 6102)?.data
        assert(
            packets.findIndex((packet) => packet.id === 6102) < packets.findIndex((packet) => packet.id === 10201),
            'queue sync reaches the client before its accepted callback',
        )
        assert.equal(home.home_builds.find((build) => build.guid === 18).product[0].product_id, job.productId)
        const sealed = structuredClone(job.cookingUnits)
        call('EnterWorldMap', returnPoint)
        assert.equal(f.state().world.map_id, returnPoint.map_id)
        assert.deepEqual(f.state().home.productionJobs[18][0].cookingUnits, sealed)
        const second = {}
        call('EnterGame', { open_id: 'current-cooking' }, second)
        assert.deepEqual(f.state().home.productionJobs[18][0].cookingUnits, sealed)
        now += job.seconds * job.count
        const claim = call('ProductFinish', { guid: 18, is_all: true }, second).find(
            (packet) => packet.id === 6111,
        ).data
        assert.equal(
            claim.reward.rewards.reduce((sum, row) => sum + row.itemnum, 0),
            3,
        )
        assert.equal(stock(f.state(), 9000202), 3)
    } finally {
        f.store.close()
    }
})

test('current mill wheat-flour wire10201 spends grain, synchronizes its queue and pays actual flour only on6111 claim', () => {
    const f = fixture(1028, [1], 2),
        protocol = new Protocol(configuration().base),
        session = {}
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, f.store, tables, {
        clock: () => now,
        rng: () => assert.fail('integer flour grade never draws'),
    })
    const call = (name, data, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    try {
        call('EnterGame', { open_id: 'current-cooking' })
        call('EnterHome', {})
        assert.equal(f.state().home.builds.find((build) => build.guid === 18).build_id, 20141)
        assert.equal(f.recipe.product.type, 2)
        assert.deepEqual(f.request.cook_material, [{ item_id: 400101, item_num: 3 }])
        assert.equal(stock(f.state(), 400101), 6)
        assert.equal(stock(f.state(), 1400101), 0)
        const packets = call('CookRequest', f.request),
            job = f.state().home.productionJobs[18][0]
        assert.equal(job.cookingConfigId, 1028)
        assert.equal(job.productId, 400101)
        assert.equal(job.count, 2)
        assert.equal(stock(f.state(), 400101), 0, 'two servings charge six actual grain')
        assert.equal(stock(f.state(), 1400101), 0, 'accepted work does not grant uncompleted flour')
        const home = packets.find((packet) => packet.id === 6102).data
        assert.equal(home.home_builds.find((build) => build.guid === 18).product[0].product_id, 400101)
        const bag = packets.find(
            (packet) => packet.id === protocol.byName.get('CSProtoSyncPlayerData').id && packet.data.sbag_infos,
        ).data.sbag_infos
        assert.equal(
            bag.items.filter((item) => item.itemid === 400101).reduce((sum, item) => sum + item.itemnum, 0),
            0,
        )
        assert(packets.findIndex((packet) => packet.id === 6102) < packets.findIndex((packet) => packet.id === 10201))
        const before = f.state()
        assert.throws(() => call('ProductFinish', { guid: 18, is_all: true }), /No finished production/)
        assert.deepEqual(f.state(), before)
        const second = {}
        call('EnterGame', { open_id: 'current-cooking' }, second)
        assert.deepEqual(f.state().home.productionJobs[18][0].cookingUnits, job.cookingUnits)
        now += job.seconds * job.count
        const finished = call('ProductFinish', { guid: 18, is_all: true }, second).find(
            (packet) => packet.id === 6111,
        ).data
        assert.equal(
            finished.reward.rewards
                .filter((item) => item.itemtype === 3 && item.itemid === 1400101)
                .reduce((sum, item) => sum + item.itemnum, 0),
            2,
        )
        assert.equal(stock(f.state(), 1400101), 2)
        assert.equal(stock(f.state(), 400101), 0)
        assert.deepEqual(f.state().home.productionJobs[18], [])
        assert.equal(cookingVarietyValue(tables, f.state(), [12210, 30]), 0, 'mill processing is not cooking variety')
        const after = f.state()
        assert.throws(() => call('ProductFinish', { guid: 18, product_guids: [job.guid] }, second))
        assert.deepEqual(f.state(), after)
    } finally {
        f.store.close()
    }
})
