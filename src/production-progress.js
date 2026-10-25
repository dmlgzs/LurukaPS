import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { productionTables } from './production-tables.js'
import { parseRewards } from './rewards.js'
import policy from '../configs/production-progress-policy.json' with { type: 'json' }

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogues = new WeakMap()
const categoryCatalogues = new WeakMap()
const cookingCatalogues = new WeakMap()
const unclassifiedCookingOutputs = new WeakMap()
ensure(
    policy.version === 1 &&
        policy.creditOn === 'successful-output-claim' &&
        policy.historical === 'do-not-reinterpret-untyped-counts' &&
        policy.officially_verified === false &&
        policy.categorySelector === 'WorldMapBuildType/common_item.type/resource3',
    'Invalid production progress policy',
    ErrorCode.GameConfig,
)

function catalogue(external) {
    const tables = productionTables(external)
    if (catalogues.has(tables)) return catalogues.get(tables)
    const buildingGroups = new Map(tables.get('home_building_group').map((row) => [row.groupId, row.type]))
    const buildings = new Map(tables.get('home_building').map((row) => [row.id, buildingGroups.get(row.groupId)]))
    const stationTypes = new Map()
    for (const station of tables.get('home_building_production')) {
        const type = buildings.get(station.id)
        if (![2, 8, 10].includes(type)) continue
        if (!stationTypes.has(station.groupId)) stationTypes.set(station.groupId, new Set())
        stationTypes.get(station.groupId).add(type)
    }
    const keys = new Set()
    const add = (groups, rewards) => {
        for (const group of String(groups).split('|').map(Number))
            for (const type of stationTypes.get(group) ?? [])
                for (const reward of rewards) {
                    keys.add(`${type}:${reward.itemtype}:${reward.itemid}`)
                    // Only the three current wildcard selector domains are established.
                    if (['2:10', '2:25', '8:33'].includes(`${type}:${reward.itemtype}`))
                        keys.add(`${type}:${reward.itemtype}:0`)
                }
    }
    for (const row of tables.get('products'))
        if (!row.notReleased && !row.isNeedPet) add(row.group, parseRewards(row.rewardId))
    // Current accessory jobs preserve a preselected type33 output. Do not use
    // obsolete products/group13 or pretend a wildcard identifies a specific leaf.
    for (const row of tables.get('accessory_product')) add(row.group, [{ itemtype: 33, itemid: 0 }])
    const result = { keys, buildings }
    catalogues.set(tables, result)
    return result
}

export function productionProgressRule(tables, tokens) {
    if (!Array.isArray(tokens) || tokens.length !== 5 || tokens[0] !== 12018 || !tokens.every(uint)) return false
    const [, type, resource, id, target] = tokens
    return type > 0 && resource > 0 && target > 0 && catalogue(tables).keys.has(`${type}:${resource}:${id}`)
}

function history(state) {
    const ledger = state.home?.productionProgress
    if (ledger === undefined) return { version: 1, counts: {} }
    ensure(
        object(ledger) && ledger.version === 1 && object(ledger.counts),
        'Malformed production progress history',
        ErrorCode.GameConfig,
    )
    for (const [key, count] of Object.entries(ledger.counts)) {
        const values = key.split(':').map(Number)
        ensure(
            values.length === 3 &&
                values.every((value) => uint(value) && value > 0) &&
                values.join(':') === key &&
                uint(count),
            'Malformed production progress counter',
            ErrorCode.GameConfig,
        )
    }
    return ledger
}

// Called only after grantRewards succeeds, in the existing claim transaction.
// Refunds, hatch receipts, inventory/GM grants and portable crafting never call it.
export function recordProductionOutput(tables, state, build, rewards) {
    const type = catalogue(tables).buildings.get(build.build_id)
    ensure(
        uint(type) && type > 0 && build.build_type === type,
        'Production building type does not match configuration',
        ErrorCode.GameConfig,
    )
    const previous = history(state),
        counts = { ...previous.counts }
    for (const row of rewards) {
        ensure(
            [row.itemtype, row.itemid, row.itemnum].every((value) => uint(value) && value > 0),
            'Invalid production progress output',
            ErrorCode.GameConfig,
        )
        const key = `${type}:${row.itemtype}:${row.itemid}`,
            next = (counts[key] ?? 0) + row.itemnum
        ensure(uint(next), 'Production progress overflow', ErrorCode.GameConfig)
        counts[key] = next
    }
    state.home.productionProgress = { version: 1, counts }
}

export function productionProgressValue(tables, state, tokens, facts = new Map()) {
    if (!productionProgressRule(tables, tokens)) return null
    const [, type, resource, id] = tokens,
        key = `production:${type}:${resource}:${id}`
    if (facts.has(key)) return facts.get(key)
    const ledger = facts.get('production:history') ?? history(state)
    facts.set('production:history', ledger)
    let count = 0
    for (const [selector, value] of Object.entries(ledger.counts)) {
        const [building, itemtype, itemid] = selector.split(':').map(Number)
        if (building === type && itemtype === resource && (id === 0 || itemid === id)) count += value
    }
    ensure(Number.isSafeInteger(count) && count >= 0, 'Production progress total overflow', ErrorCode.GameConfig)
    facts.set(key, count)
    return count
}

// HomeProductsItemType shares the existing successful-claim ledger. The
// building selector is WorldMapBuildType; the second selector is common_item.type.
function categoryCatalogue(external) {
    const tables = productionTables(external)
    if (categoryCatalogues.has(tables)) return categoryCatalogues.get(tables)
    const itemCategories = new Map()
    for (const row of tables.get('common_item')) {
        ensure(
            uint(row.id) && row.id > 0 && uint(row.type) && !itemCategories.has(row.id),
            'Malformed production item category configuration',
            ErrorCode.GameConfig,
        )
        itemCategories.set(row.id, row.type)
    }
    const selectors = new Set()
    for (const key of catalogue(tables).keys) {
        const [building, resource, id] = key.split(':').map(Number)
        const category = itemCategories.get(id)
        if (resource === 3 && category > 0) selectors.add(building + ':' + category)
    }
    const result = { selectors, itemCategories }
    categoryCatalogues.set(tables, result)
    return result
}

export function productionCategoryRule(tables, tokens) {
    if (!Array.isArray(tokens) || tokens.length !== 4 || tokens[0] !== 15021 || !tokens.every(uint)) return false
    const [, type, category, target] = tokens
    return type > 0 && category > 0 && target > 0 && categoryCatalogue(tables).selectors.has(type + ':' + category)
}

export function productionCategoryValue(tables, state, tokens, facts = new Map()) {
    if (!productionCategoryRule(tables, tokens)) return null
    const [, type, category] = tokens,
        key = 'production-category:' + type + ':' + category
    if (facts.has(key)) return facts.get(key)
    const ledger = facts.get('production:history') ?? history(state)
    facts.set('production:history', ledger)
    const { itemCategories } = categoryCatalogue(tables)
    let count = 0
    for (const [selector, value] of Object.entries(ledger.counts)) {
        const [building, resource, id] = selector.split(':').map(Number)
        if (building === type && resource === 3 && itemCategories.get(id) === category) count += value
    }
    ensure(Number.isSafeInteger(count) && count >= 0, 'Production category total overflow', ErrorCode.GameConfig)
    facts.set(key, count)
    return count
}

function cookingCatalogue(external) {
    const tables = productionTables(external)
    ensure(
        policy.cookingVariety?.condition === 12210 &&
            policy.cookingVariety.selector === 'WorldMapBuildType10/resource3/products_multi_quality.productGroup' &&
            policy.cookingVariety.quality === 'all-known-qualities-per-group' &&
            policy.cookingVariety.unknownOutputs === 'ignore-unmapped-with-once-log' &&
            policy.cookingVariety.officiallyVerified === false,
        'Invalid cooking variety progress policy',
        ErrorCode.GameConfig,
    )
    if (cookingCatalogues.has(tables)) return cookingCatalogues.get(tables)
    const foods = new Set(),
        groups = new Set(),
        outputGroups = new Map(),
        nonCookingOutputs = new Set(),
        recipeOutputs = new Map()
    for (const row of tables.get('food')) {
        ensure(row && uint(row.id) && !foods.has(row.id), 'Malformed cooking food catalogue', ErrorCode.GameConfig)
        foods.add(row.id)
    }
    for (const row of tables.get('food_group')) {
        ensure(
            row && uint(row.id) && !groups.has(row.id),
            'Malformed cooking food group catalogue',
            ErrorCode.GameConfig,
        )
        groups.add(row.id)
    }
    for (const row of tables.get('products_multi_quality')) {
        ensure(row && uint(row.productId) && row.productId > 0, 'Malformed cooking quality row', ErrorCode.GameConfig)
        const recipe = tables.find('products', row.productId)
        if (recipe?.type === 2 && uint(row.id) && row.id > 0 && recipe.rewardId === `3#${row.id}#1`) {
            nonCookingOutputs.add(row.id)
            continue
        }
        if (recipe?.type !== 3) continue // The same protocol also processes mill ingredients.
        ensure(
            uint(row.id) &&
                row.id > 0 &&
                foods.has(row.id) &&
                uint(row.productGroup) &&
                row.productGroup > 0 &&
                groups.has(row.productGroup) &&
                uint(row.productRarity) &&
                !outputGroups.has(row.id) &&
                !recipeOutputs.has(recipe.id) &&
                recipe.rewardId === `3#${row.id}#1`,
            'Cooking recipe output has no unique food group',
            ErrorCode.GameConfig,
        )
        outputGroups.set(row.id, row.productGroup)
        recipeOutputs.set(recipe.id, row.id)
    }
    for (const recipe of tables.get('products'))
        if (recipe.type === 3 && !recipe.notReleased)
            ensure(recipeOutputs.has(recipe.id), 'Current cooking output is not classified', ErrorCode.GameConfig)
    ensure(outputGroups.size > 0, 'Cooking variety catalogue is empty', ErrorCode.GameConfig)
    const result = { outputGroups, nonCookingOutputs, groups: new Set(outputGroups.values()), tables }
    cookingCatalogues.set(tables, result)
    return result
}

export function cookingVarietyRule(tables, tokens) {
    return (
        Array.isArray(tokens) &&
        tokens.length === 2 &&
        tokens[0] === 12210 &&
        uint(tokens[1]) &&
        tokens[1] > 0 &&
        tokens[1] <= cookingCatalogue(tables).groups.size
    )
}

// All proven modern10201 routes use an owned cooking station, including remote
// HomeCenter access from the world. The current map never filters these facts.
export function cookingVarietyValue(tables, state, tokens, facts = new Map()) {
    if (!cookingVarietyRule(tables, tokens)) return null
    const key = 'cooking-variety:food-groups'
    if (facts.has(key)) return facts.get(key)
    const ledger = facts.get('production:history') ?? history(state)
    facts.set('production:history', ledger)
    const model = cookingCatalogue(tables),
        known = new Set()
    for (const [selector, value] of Object.entries(ledger.counts)) {
        const [building, resource, id] = selector.split(':').map(Number)
        if (building !== 10 || resource !== 3 || value === 0) continue
        const group = model.outputGroups.get(id)
        if (group !== undefined) known.add(group)
        else if (!model.nonCookingOutputs.has(id)) {
            // Known mill outputs are silently outside this domain. Unmapped
            // old/failure outputs cannot invent a group or prevent rewards/login.
            let warned = unclassifiedCookingOutputs.get(model.tables)
            if (!warned) unclassifiedCookingOutputs.set(model.tables, (warned = new Set()))
            if (!warned.has(id)) {
                warned.add(id)
                console.warn('[cooking-variety]', JSON.stringify({ event: 'unmapped-output', itemId: id }))
            }
        }
    }
    facts.set(key, known.size)
    return known.size
}
