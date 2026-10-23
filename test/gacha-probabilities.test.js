import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import settings from '../configs/gacha-probability-models.json' with { type: 'json' }
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { GachaCatalog } from '../src/gacha.js'
import { GachaDrawEngine } from '../src/gacha-draw.js'
import { gachaTables } from '../src/gacha-tables.js'
import { gachaRulesForDraw } from '../src/gacha-probabilities.js'
import { gachaPoolDetail } from '../src/gacha-detail.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = gachaTables(new Tables(cfg.tables)),
    catalog = new GachaCatalog(tables)
const compiled = (id, policy) => new GachaDrawEngine(catalog, tables, policy).compile(catalog.configuration(id))
const drawRules = (model, count) =>
    gachaRulesForDraw(model, { pity: [{ pity_id: model.probabilityModel.rule_id, pity_count: count }] })
function fixture(name, { database = ':memory:', rng = (max) => max - 1, policy } = {}) {
    const store = new Store(database),
        protocol = new Protocol(cfg.base),
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => 1800000000, rng, gachaPolicy: policy })
    let sequence = 1
    const frame = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, data) }
    }
    const dispatch = (request) => {
        const entry = protocol.byId.get(request.id),
            packets = game.dispatch(session, request)
        return { packets, data: protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload) }
    }
    const call = (name, data = {}) => dispatch(frame(name, data))
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    const fund = (id, count) => edit((s) => grantRewards(tables, s, [{ itemtype: 3, itemid: id, itemnum: count }]))
    const setPity = (id, count, four = 0) =>
        edit((s) => {
            const rows = s.gacha.pools[id].pity
            rows.find((row) => row.pity_id === compiled(id).probabilityModel.rule_id).pity_count = count
            rows.find((row) => catalog.guarantees.get(row.pity_id).guaranteeType === 3).pity_count = four
        })
    return { store, game, protocol, session, frame, dispatch, call, state, edit, fund, setPity }
}

test('configured hero and soul profiles bind actual limited/permanent guarantees and preserve novice rules', () => {
    for (const id of [1001, 9001, 2001, 10001]) {
        const model = compiled(id),
            original = structuredClone(model.rules),
            hero = [1001, 9001].includes(id)
        const cases = hero
            ? [
                  [0, 800],
                  [69, 800],
                  [70, 1000],
                  [79, 2800],
                  [88, 4600],
                  [89, 100000],
                  [100, 100000],
              ]
            : [
                  [0, 1200],
                  [59, 1200],
                  [60, 2400],
                  [69, 13200],
                  [78, 24000],
                  [79, 100000],
                  [100, 100000],
              ]
        assert.equal(model.probabilityModel.id, hero ? 'hero' : 'soulessence')
        for (const [count, gold] of cases) {
            const rules = drawRules(model, count),
                top = rules.find((row) => row.guaranteeId === model.probabilityModel.rule_id)
            assert.equal(top.probability_mass, gold)
            assert.equal(
                rules.filter((row) => row.minimum === 3).reduce((sum, row) => sum + row.probability_mass, 0),
                gold === 100000 ? 0 : 6000,
            )
            assert.equal(rules.at(-1).probability_mass, gold === 100000 ? 0 : 100000 - gold - 6000)
            assert.equal(
                rules.reduce((sum, row) => sum + row.probability_mass, 0),
                100000,
            )
        }
        assert.deepEqual(model.rules, original, 'per-draw probabilities must not mutate base rates or another account')
    }
    const novice = compiled(8001)
    assert.equal(novice.probabilityModel, null)
    assert.equal(novice.rules.find((row) => row.guaranteeId === 801).guaranteeCount, 30)
    assert.equal(novice.rules.find((row) => row.guaranteeId === 801).probability_mass, 0)
    assert.equal(gachaRulesForDraw(novice, { pity: [] }), novice.rules)
})

test('finite survival sums reproduce the PDF hero model and the user-selected soul model', () => {
    for (const [id, mean, rate, hardChance] of [
        [1001, 63.10823150925066, 0.015845793426383942, 0.33185777275395917],
        [2001, 47.83022114729091, 0.020907283638111295, 0.03115388659476713],
    ]) {
        const model = compiled(id)
        let survival = 1,
            total = 0,
            expectation = 0,
            last = 0
        for (let n = 1; n <= model.probabilityModel.hard_pity; n++) {
            expectation += survival
            const p =
                drawRules(model, n - 1).find((row) => row.guaranteeId === model.probabilityModel.rule_id)
                    .probability_mass / model.scale
            last = survival * p
            total += last
            survival *= 1 - p
        }
        assert(Math.abs(expectation - mean) < 1e-10)
        assert(Math.abs(1 / expectation - rate) < 1e-14)
        assert(Math.abs(total - 1) < 1e-12)
        assert.equal(survival, 0)
        assert(Math.abs(last - hardChance) < 1e-12)
        assert.equal((100 / expectation).toFixed(2), id === 1001 ? '1.58' : '2.09')
    }
})

test('real9701 draws use each pool soft boundary, keep the six-percent band and prefer gold over the four-star guarantee', () => {
    for (const [id, ticket, count, threshold] of [
        [1001, 501001, 70, 1000],
        [2001, 501002, 60, 2400],
    ]) {
        let roll = 0
        const f = fixture('gacha-model-boundary-' + id, { rng: (max) => (max === 100000 ? roll : 0) })
        try {
            f.fund(ticket, 8)
            for (const [value, rarity] of [
                [threshold - 1, 4],
                [threshold, 3],
                [threshold + 5999, 3],
                [threshold + 6000, 2],
            ]) {
                roll = value
                f.setPity(id, count)
                const item = f.call('GachaDraw', { pool_id: id, draw_count: 1 }).data.gacha_results[0].main_item
                assert.equal(tables.find(item.item_type === 1 ? 'hero' : 'soulessence', item.item_id).rarity, rarity)
                if (rarity === 4)
                    assert.equal(
                        f
                            .state()
                            .gacha.pools[id].pity.find((row) => row.pity_id === compiled(id).probabilityModel.rule_id)
                            .pity_count,
                        0,
                    )
            }
            roll = threshold - 1
            f.setPity(id, count, 9)
            const gold = f.call('GachaDraw', { pool_id: id, draw_count: 1 }).data
            assert(
                gold.pool_info.pity
                    .filter((row) => catalog.guarantees.get(row.pity_id).guaranteeCount > 0)
                    .every((row) => row.pity_count === 0),
            )
            roll = 99999
            f.setPity(id, compiled(id).probabilityModel.hard_pity - 1, 9)
            const hard = f.call('GachaDraw', { pool_id: id, draw_count: 1 }).data.gacha_results[0].main_item
            assert.equal(tables.find(hard.item_type === 1 ? 'hero' : 'soulessence', hard.item_id).rarity, 4)
        } finally {
            f.store.close()
        }
    }
})

test('ten-pulls cross each soft start then reset the curve immediately and replay without another random draw', () => {
    for (const [id, ticket, beforeSoft, boundaryRoll] of [
        [1001, 501001, 69, 999],
        [2001, 501002, 59, 1999],
    ]) {
        const rolls = [boundaryRoll, boundaryRoll, boundaryRoll, ...Array(7).fill(99999)]
        let used = 0
        const f = fixture('gacha-model-sequential-' + id, { rng: (max) => (max === 100000 ? rolls[used++] : 0) })
        try {
            f.fund(ticket, 10)
            f.setPity(id, beforeSoft)
            const request = f.frame('GachaDraw', { pool_id: id, draw_count: 10 })
            const result = f.dispatch(request).data
            const rarities = result.gacha_results.map(
                ({ main_item: item }) =>
                    tables.find(item.item_type === 1 ? 'hero' : 'soulessence', item.item_id).rarity,
            )
            assert.deepEqual(rarities.slice(0, 3), [3, 4, 3])
            assert.equal(rarities.filter((rarity) => rarity === 4).length, 1)
            assert.equal(
                result.pool_info.pity.find((row) => row.pity_id === compiled(id).probabilityModel.rule_id).pity_count,
                8,
            )
            assert.equal(used, 10)
            const saved = structuredClone(f.state())
            assert.deepEqual(f.dispatch(request).data.gacha_results, result.gacha_results)
            assert.deepEqual(f.state(), saved)
            assert.equal(used, 10)
        } finally {
            f.store.close()
        }
    }
})

test('soft probability counts survive a real SQLite reopen without resetting an already paid account', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gacha-model-')),
        database = path.join(directory, 'state.db'),
        stores = []
    try {
        const first = fixture('gacha-model-durable', { database, rng: (max) => (max === 100000 ? 999 : 0) })
        stores.push(first.store)
        first.fund(501001, 2)
        first.setPity(1001, 70)
        first.store.close()
        const next = fixture('gacha-model-durable', { database, rng: (max) => (max === 100000 ? 999 : 0) })
        stores.push(next.store)
        assert.equal(next.state().gacha.pools[1001].pity.find((row) => row.pity_id === 101).pity_count, 70)
        const gold = next.call('GachaDraw', { pool_id: 1001, draw_count: 1 }).data.gacha_results[0].main_item
        assert.equal(gold.item_id, 101010)
        const normal = next.call('GachaDraw', { pool_id: 1001, draw_count: 1 }).data.gacha_results[0].main_item
        assert.equal(tables.find(normal.item_type === 1 ? 'hero' : 'soulessence', normal.item_id).rarity, 3)
        assert.equal(next.state().gacha.pools[1001].pity.find((row) => row.pity_id === 101).pity_count, 1)
        assert.equal(next.state().gacha.history.length, 2)
    } finally {
        for (const store of stores) store.close()
        const root = fs.realpathSync(os.tmpdir())
        const relative = path.relative(root, fs.realpathSync(directory))
        assert(
            relative &&
                !relative.startsWith('..') &&
                !path.isAbsolute(relative) &&
                path.basename(directory).startsWith('gacha-model-'),
        )
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('hero and soul models keep separate limited and permanent category counters', () => {
    let roll = 999
    const f = fixture('gacha-model-category-isolation', { rng: (max) => (max === 100000 ? roll : 0) })
    try {
        f.fund(501001, 1)
        f.fund(501002, 1)
        f.setPity(1001, 70)
        f.setPity(2001, 60)
        f.call('GachaDraw', { pool_id: 1001, draw_count: 1 })
        const pity = (id) =>
            f.state().gacha.pools[id].pity.find((row) => row.pity_id === compiled(id).probabilityModel.rule_id)
                .pity_count
        assert.equal(pity(1001), 0)
        assert.equal(pity(2001), 60)
        assert.equal(pity(9001), 0)
        assert.equal(pity(10001), 0)
        roll = 2399
        f.call('GachaDraw', { pool_id: 2001, draw_count: 1 })
        assert.equal(pity(2001), 0)
        assert.equal(pity(1001), 0)
        assert.equal(pity(9001), 0)
        assert.equal(pity(10001), 0)
    } finally {
        f.store.close()
    }
})

test('malformed or table-incompatible model settings reject before charging tickets or committing receipts', () => {
    const invalid = structuredClone(settings),
        f = fixture('gacha-model-invalid', { policy: { probability_models: invalid } })
    try {
        f.fund(501001, 1)
        for (const change of [
            (row) => (row.increment_mass = 0),
            (row) => (row.increment_mass = 100000),
            (row) => (row.expected_scale = 10000),
            (row) => (row.expected_base_mass = 801),
            (row) => (row.expected_hard_pity = 89),
            (row) => (row.gacha_types = [1, 1]),
        ]) {
            invalid.profiles = structuredClone(settings.profiles)
            change(invalid.profiles[0])
            const saved = structuredClone(f.state())
            assert.throws(
                () => f.call('GachaDraw', { pool_id: 1001, draw_count: 1 }),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), saved)
        }
    } finally {
        f.store.close()
    }
})

test('HTTP detail describes the distinct curves while retaining ordinary base rates and the novice tutorial contract', () => {
    const detail = (id) => gachaPoolDetail(catalog, new GachaDrawEngine(catalog, tables), tables, id)
    for (const id of [1001, 9001])
        assert.match(JSON.stringify(detail(id).detail_description), /第71次起每次增加0\.2个百分点，第90次必得五星/)
    for (const id of [2001, 10001])
        assert.match(JSON.stringify(detail(id).detail_description), /第61次起每次增加1\.2个百分点，第80次必得五星/)
    assert.equal(detail(2001).probability_detail.star5.text, '基础概率 1.2%')
    assert.equal(detail(2001).probability_detail.star4.text, '基础概率 6%')
    assert.equal(detail(2001).probability_detail.star3.text, '基础概率 92.8%')
    assert(!JSON.stringify(detail(8001).detail_description).includes('个百分点'))
    assert.match(JSON.stringify(detail(8001).detail_description), /30次/)
    assert.match(JSON.stringify(detail(9001).detail_description), /首次单次观测免费/)
})
