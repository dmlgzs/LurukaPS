import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { ErrorCode } from '../src/error-codes.js'
import { cookingOutputCatalogue } from '../src/cooking-output-catalogue.js'
import { cookingVarietyRule, cookingVarietyValue } from '../src/production-progress.js'
import { achievementCatalogue } from '../src/achievements.js'

const tables = new Tables(configuration().tables)
function provider(overrides) {
    return {
        get(name) {
            return overrides[name] ?? tables.get(name)
        },
        find(name, id) {
            return this.get(name).find((row) => row.id === id)
        },
    }
}

test('actual 1.0 quality groups classify all 225 cooking variants into 49 recipes and exclude 30 processing variants', () => {
    const model = cookingOutputCatalogue(tables)
    assert.equal(tables.get('products_multi_quality').length, 55)
    assert.equal(model.schema, 'recipe-groups')
    assert.equal(model.groupSource, 'products_multi_quality.id')
    assert.equal(model.recipeOutputs.size, 255)
    assert.equal(model.outputGroups.size, 225)
    assert.equal(model.groups.size, 49)
    assert.equal(model.nonCookingOutputs.size, 30)
    for (const [productId, itemId] of model.recipeOutputs) {
        const product = tables.find('products', productId)
        assert.equal(product.rewardId, `3#${itemId}#1`)
        if (product.type === 3) assert(tables.find('food', itemId))
    }
    assert.equal(model.outputGroups.get(9000101), 1001)
    assert.equal(model.outputGroups.get(9000105), 1001)
    assert.equal(cookingVarietyRule(tables, [12210, 49]), true)
    assert.equal(cookingVarietyRule(tables, [12210, 50]), false)
})

test('current variety counting regroups claimed output facts without adding old group IDs or inventory history', () => {
    const model = cookingOutputCatalogue(tables),
        sameRecipe = [...model.outputGroups].filter(([, id]) => id === 1001),
        saved = {
            home: {
                productionProgress: {
                    version: 1,
                    counts: Object.fromEntries(sameRecipe.map(([itemId]) => [`10:3:${itemId}`, 1])),
                },
                craftCounts: { 1001: 1000, 1: 1000 },
                cookCounts: { 9000101: 1000 },
            },
            player: { sbag_infos: { items: [{ itemid: 9000201, itemnum: 1000 }] } },
        },
        before = structuredClone(saved)
    assert.equal(cookingVarietyValue(tables, saved, [12210, 30]), 1)
    assert.deepEqual(saved, before)
    const ledger = saved.home.productionProgress.counts
    for (const [itemId] of model.outputGroups) ledger[`10:3:${itemId}`] = 1
    for (const itemId of model.nonCookingOutputs) ledger[`10:3:${itemId}`] = 10
    assert.equal(cookingVarietyValue(tables, saved, [12210, 30]), 49)
    assert.equal(cookingVarietyValue(tables, { home: { craftCounts: { 1001: 1000 } } }, [12210, 30]), 0)
})

test('unknown outputs remain stored facts and emit at most one diagnostic while known processing is excluded', () => {
    const model = cookingOutputCatalogue(tables),
        processing = [...model.nonCookingOutputs][0],
        saved = {
            home: { productionProgress: { version: 1, counts: { [`10:3:${processing}`]: 5, '10:3:4294967295': 1 } } },
        },
        before = structuredClone(saved),
        warn = console.warn,
        messages = []
    try {
        console.warn = (...args) => messages.push(args)
        assert.equal(cookingVarietyValue(tables, saved, [12210, 10]), 0)
        assert.equal(cookingVarietyValue(tables, saved, [12210, 10]), 0)
        assert.equal(messages.filter(([tag]) => tag === '[cooking-variety]').length, 1)
        assert.deepEqual(saved, before)
    } finally {
        console.warn = warn
    }
})

test('explicit legacy numeric output rows retain their food-group classification', () => {
    const legacy = provider({
        products_multi_quality: [
            { id: 9000101, productId: 9100101, productGroup: 1, productRarity: 1 },
            { id: 9000102, productId: 9100102, productGroup: 1, productRarity: 2 },
            { id: 9000201, productId: 9100201, productGroup: 2, productRarity: 1 },
        ],
        products: [
            { id: 9100101, type: 3, rewardId: '3#9000101#1' },
            { id: 9100102, type: 3, rewardId: '3#9000102#1' },
            { id: 9100201, type: 3, rewardId: '3#9000201#1' },
        ],
        food: [{ id: 9000101 }, { id: 9000102 }, { id: 9000201 }],
        food_group: [{ id: 1 }, { id: 2 }],
    })
    const model = cookingOutputCatalogue(legacy),
        saved = { home: { productionProgress: { version: 1, counts: { '10:3:9000101': 1, '10:3:9000102': 1 } } } },
        before = structuredClone(saved)
    assert.equal(model.schema, 'legacy-output-rows')
    assert.equal(model.outputGroups.get(9000101), 1)
    assert.equal(cookingVarietyValue(legacy, saved, [12210, 1]), 1)
    assert.equal(cookingVarietyValue(tables, saved, [12210, 1]), 1)
    assert.deepEqual(saved, before)
})

test('malformed, duplicate or incomplete current quality maps fail instead of producing an empty catalogue', () => {
    const rows = tables.get('products_multi_quality'),
        cases = [
            [...rows, { ...rows[0] }],
            [{ ...rows[0], productId: '1#9100101|1#9100102' }, ...rows.slice(1)],
            [{ ...rows[0], productId: '1#999999999' }, ...rows.slice(1)],
            [{ ...rows[0], productId: '1#9100101|' }, ...rows.slice(1)],
            [{ ...rows[0], productId: 9100101 }, ...rows.slice(1)],
            rows.slice(1),
        ]
    for (const products_multi_quality of cases)
        assert.throws(() => cookingOutputCatalogue(provider({ products_multi_quality })), {
            code: ErrorCode.GameConfig,
        })
    assert.throws(
        () => cookingOutputCatalogue(provider({ food: tables.get('food').filter((row) => row.id !== 9000101) })),
        { code: ErrorCode.GameConfig },
    )
    const withoutOldFoodGroups = provider({ food_group: [] })
    assert.equal(cookingOutputCatalogue(withoutOldFoodGroups).groups.size, 49)
})

test('actual current achievement catalogue no longer fails on grouped cooking variants', () => {
    const model = achievementCatalogue(tables),
        cooking = model.rows.filter((row) => row.finishCondition.startsWith('12210#'))
    assert(cooking.length > 0)
    assert(cooking.every((row) => model.rules.get(row.id).supported))
})
