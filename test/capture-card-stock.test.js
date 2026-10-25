import test from 'node:test'
import assert from 'node:assert/strict'
import { captureCardStockRule, captureCardStockValue } from '../src/capture-card-stock.js'
import { achievementCatalogue } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'
import { cardTables } from './capture-card-stock-fixture.js'

const tokens = [15022, 410, 1000]
const state = (items, debt) => ({
    player: { sbag_infos: { items } },
    ...(debt === undefined ? {} : { mallDebtPack: { debt_list: debt } }),
})
const item = (itemid, itemnum, guid) => ({ itemid, itemnum, itemtype: 3, guid })
test('current complete15022 family selects common-item410 and counts aggregate quantity, not instances or other inventories', () => {
    const model = achievementCatalogue(cardTables)
    const rows = model.rows.filter((r) => captureCardStockRule(cardTables, model.rules.get(r.id).tokens))
    assert.deepEqual(
        rows.map((r) => r.id),
        [2020026],
    )
    assert(model.rules.get(2020026).supported)
    const s = state([item(1000001, 600, '1'), item(1000001, 400, '2'), item(1000002, 20, '3'), item(300000, 5000, '4')])
    s.ornaments = [{ id: 1000001, guid: '999', itemnum: 9000 }]
    s.simpleProduced = { '3:1000001': 1000000 }
    s.petCatchCards = { 1: { item_id: 1000001, state: 'reserved' } }
    const facts = new Map()
    assert.equal(captureCardStockValue(cardTables, s, tokens, facts), 1020)
    assert.equal(captureCardStockValue(cardTables, s, tokens, facts), 1020)
    assert.equal(captureCardStockRule(cardTables, [15022, 606, 1000]), false)
    assert.equal(captureCardStockRule(cardTables, [15022, 410, 1000, 0]), false)
})
test('capture-card debt is subtracted once perID after stacking and signed deficits survive until final aggregate boundary', () => {
    const s = state(
        [item(1000001, 100, '1'), item(1000001, 100, '2'), item(1000002, 900, '3')],
        [{ item_type: 3, item_id: 1000001, item_debt: '300' }],
    )
    assert.equal(captureCardStockValue(cardTables, s, tokens), 800)
    s.mallDebtPack.debt_list[0].item_debt = '2000'
    assert.equal(captureCardStockValue(cardTables, s, tokens), 0)
    s.mallDebtPack.debt_list[0].item_debt = '9223372036854775807'
    assert.equal(captureCardStockValue(cardTables, s, tokens), 0)
    s.mallDebtPack.debt_list = [
        { item_type: 3, item_id: 1000001, item_debt: '500' },
        { item_type: 10, item_id: 1000001, item_debt: '200' },
    ]
    assert.equal(captureCardStockValue(cardTables, s, tokens), 900)
    s.mallDebtPack.debt_list.reverse()
    assert.equal(captureCardStockValue(cardTables, s, tokens), 600)
    s.mallDebtPack.debt_list.push({ item_id: 1000001, item_type: 0 })
    assert.equal(captureCardStockValue(cardTables, s, tokens), 1100)
    s.mallDebtPack.debt_list.push({ item_id: 1000001 })
    s.mallDebtPack.debt_list.push({})
    assert.equal(captureCardStockValue(cardTables, s, tokens), 1100)
    s.player.sbag_infos.items[0].itemtype = 0
    s.player.sbag_infos.items[1].itemtype = 15
    assert.equal(captureCardStockValue(cardTables, s, tokens), 1100)
})
test('malformed selected quantities and debt identities reject instead of inflating stock or simulating client integer wrap', () => {
    const invalid = [
        state([item(1000001, 0x80000000, '1')]),
        state([item(1000001, 0x7fffffff, '1'), item(1000001, 1, '2')]),
        state([item(1000001, -1, '1')]),
        state([item(1000001, 1000, '1')], [{ item_type: 3, item_id: 1000001, item_debt: '9223372036854775808' }]),
        state([], [{ item_type: 'invalid', item_id: 1000001, item_debt: 1 }]),
        state([], [[]]),
        state(
            [],
            [
                { item_type: 3, item_id: 1000001, item_debt: -1 },
                { item_type: 10, item_id: 1000001, item_debt: 1 },
            ],
        ),
    ]
    for (const s of invalid)
        assert.throws(
            () => captureCardStockValue(cardTables, s, tokens),
            (e) => e.code === ErrorCode.GameConfig,
        )
})
