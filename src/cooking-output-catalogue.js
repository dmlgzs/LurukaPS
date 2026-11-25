import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff

// The 1.0 Lua productsMultiQualityTpl maps configId -> grade/productId ->
// products.rewardId's common item -> configId. It explicitly retires the old
// productGroup/foodGroup API. This only classifies claimed output facts; it
// does not implement the new material-quality selection or CookRequest rules.
export function cookingOutputCatalogue(tables) {
    const rows = tables.get('products_multi_quality')
    ensure(Array.isArray(rows) && rows.length > 0, 'Cooking quality catalogue is empty', ErrorCode.GameConfig)
    const grouped = rows.every((row) => typeof row?.productId === 'string'),
        legacy = rows.every((row) => positive(row?.productId))
    ensure(grouped || legacy, 'Mixed or malformed cooking quality schemas', ErrorCode.GameConfig)
    const foods = new Set(),
        legacyGroups = new Set(),
        rowIds = new Set(),
        outputGroups = new Map(),
        nonCookingOutputs = new Set(),
        recipeOutputs = new Map()
    for (const row of tables.get('food')) {
        ensure(row && positive(row.id) && !foods.has(row.id), 'Malformed cooking food catalogue', ErrorCode.GameConfig)
        foods.add(row.id)
    }
    if (legacy)
        for (const row of tables.get('food_group')) {
            ensure(
                row && positive(row.id) && !legacyGroups.has(row.id),
                'Malformed cooking food group catalogue',
                ErrorCode.GameConfig,
            )
            legacyGroups.add(row.id)
        }
    for (const row of rows) {
        ensure(
            row && positive(row.id) && !rowIds.has(row.id),
            'Duplicate or invalid cooking quality row',
            ErrorCode.GameConfig,
        )
        rowIds.add(row.id)
        let variants
        if (grouped) {
            ensure(
                typeof row.calculateNeedMaterial === 'string' &&
                    typeof row.uncalculateNeedMaterial === 'string' &&
                    /^\d+#\d+(\|\d+#\d+)*$/.test(row.productId),
                'Malformed cooking recipe group',
                ErrorCode.GameConfig,
            )
            variants = row.productId.split('|').map((pair) => pair.split('#').map(Number))
        } else variants = [[row.productRarity, row.productId]]
        const grades = new Set(),
            types = new Set()
        for (const [grade, productId] of variants) {
            ensure(
                Number.isSafeInteger(grade) &&
                    grade >= 0 &&
                    grade <= 0xffffffff &&
                    !grades.has(grade) &&
                    positive(productId) &&
                    !recipeOutputs.has(productId),
                'Duplicate or invalid cooking quality variant',
                ErrorCode.GameConfig,
            )
            grades.add(grade)
            const recipe = tables.find('products', productId),
                reward = typeof recipe?.rewardId === 'string' && /^3#([1-9]\d*)#1$/.exec(recipe.rewardId),
                outputId = reward ? Number(reward[1]) : null
            ensure(
                recipe && [2, 3].includes(recipe.type) && positive(outputId),
                'Cooking variant has no single common-item output',
                ErrorCode.GameConfig,
            )
            ensure(
                !outputGroups.has(outputId) && !nonCookingOutputs.has(outputId) && (grouped || outputId === row.id),
                'Cooking output is not uniquely classified',
                ErrorCode.GameConfig,
            )
            recipeOutputs.set(productId, outputId)
            types.add(recipe.type)
            if (recipe.type === 2) {
                nonCookingOutputs.add(outputId)
                continue
            }
            const groupId = grouped ? row.id : row.productGroup
            ensure(
                foods.has(outputId) && positive(groupId) && (grouped || legacyGroups.has(groupId)),
                'Cooking recipe output has no unique food group',
                ErrorCode.GameConfig,
            )
            outputGroups.set(outputId, groupId)
        }
        ensure(types.size === 1, 'Cooking group mixes processing and cooking recipes', ErrorCode.GameConfig)
    }
    for (const recipe of tables.get('products'))
        if (recipe.type === 3 && !recipe.notReleased)
            ensure(recipeOutputs.has(recipe.id), 'Current cooking output is not classified', ErrorCode.GameConfig)
    ensure(outputGroups.size > 0, 'Cooking variety catalogue is empty', ErrorCode.GameConfig)
    return {
        schema: grouped ? 'recipe-groups' : 'legacy-output-rows',
        groupSource: grouped ? 'products_multi_quality.id' : 'products_multi_quality.productGroup',
        outputGroups,
        nonCookingOutputs,
        recipeOutputs,
        groups: new Set(outputGroups.values()),
    }
}
