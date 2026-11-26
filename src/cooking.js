import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { cookingOutputCatalogue } from './cooking-output-catalogue.js'
import { createHash } from 'node:crypto'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const catalogues = new WeakMap()

export function cookingRequestReceipt(c, request) {
    if (!c.requestKey) return { repeated: false, commit() {} }
    const hash = (value) => createHash('sha256').update(value).digest('hex')
    const key = hash(c.requestKey),
        payload = hash(
            JSON.stringify({
                build_guid: request.build_guid,
                cook_id: request.cook_id,
                cook_count: request.cook_count,
                cook_material: request.cook_material,
            }),
        ),
        rows = c.state.home?.cookingReceipts ?? []
    ensure(
        Array.isArray(rows) &&
            rows.every((row) => /^[a-f0-9]{64}$/.test(row?.key) && /^[a-f0-9]{64}$/.test(row?.payload)),
        'Invalid cooking request receipts',
        ErrorCode.GameConfig,
    )
    const previous = rows.find((row) => row.key === key)
    ensure(
        !previous || previous.payload === payload,
        'Cooking sequence reused with different payload',
        ErrorCode.InvalidPacket,
    )
    return {
        repeated: !!previous,
        commit() {
            c.state.home.cookingReceipts = [...rows, { key, payload }].slice(-256)
        },
    }
}
function catalogue(tables) {
    if (!catalogues.has(tables)) catalogues.set(tables, cookingOutputCatalogue(tables))
    return catalogues.get(tables)
}
export function qualityProductionRecipe(tables, productId) {
    return tables
        .get('products_multi_quality')
        .some((row) =>
            typeof row.productId === 'string'
                ? row.productId.split('|').some((pair) => Number(pair.split('#')[1]) === productId)
                : row.productId === productId,
        )
}

// 1.0 sends the products_multi_quality config ID, not the food/common-item ID.
export function cookingRecipe(tables, id) {
    const row = tables.find('products_multi_quality', id)
    ensure(row, 'Unknown cooking recipe', ErrorCode.CookConfFail)
    ensure(typeof row.productId === 'string', 'Unsupported cooking recipe schema', ErrorCode.GameConfig)
    const outputs = catalogue(tables).recipeOutputs
    const variants = new Map(
        row.productId.split('|').map((pair) => {
            const [grade, productId] = pair.split('#').map(Number)
            const product = tables.find('products', productId),
                outputId = outputs.get(productId)
            ensure(
                product && positive(outputId) && tables.find('common_item', outputId),
                'Cooking product configuration is missing',
                ErrorCode.GameConfig,
            )
            return [grade, { product, rewards: [{ itemtype: 3, itemid: outputId, itemnum: 1 }] }]
        }),
    )
    const requirements = []
    for (const [field, calculate] of [
        ['calculateNeedMaterial', true],
        ['uncalculateNeedMaterial', false],
    ]) {
        ensure(typeof row[field] === 'string', 'Missing cooking material configuration', ErrorCode.GameConfig)
        for (const token of row[field].split('|').filter(Boolean)) {
            const parts = token.split('#').map(Number)
            ensure(
                parts.length === 2 && parts.every(positive),
                'Invalid cooking material requirement',
                ErrorCode.GameConfig,
            )
            const [groupId, count] = parts,
                group = tables.find('food_material_group', groupId)
            ensure(group, 'Cooking material group is missing', ErrorCode.CookMaterialGroupFail)
            const choices = new Map(),
                grades = new Set()
            for (const pair of String(group.includeItems ?? '')
                .split('|')
                .filter(Boolean)) {
                const values = pair.split('#').map(Number)
                ensure(
                    values.length === 2 && values.every(positive),
                    'Invalid cooking material group',
                    ErrorCode.GameConfig,
                )
                const [itemId, grade] = values
                ensure(
                    !choices.has(itemId) && !grades.has(grade) && tables.find('common_item', itemId),
                    'Invalid cooking material choice',
                    ErrorCode.CookMaterialConfFail,
                )
                choices.set(itemId, grade)
                grades.add(grade)
            }
            ensure(choices.size, 'Cooking material group is empty', ErrorCode.CookMaterialConfFail)
            requirements.push({ groupId, count, calculate, grades: choices, choices: [...choices.keys()] })
        }
    }
    ensure(requirements.length > 0 && requirements.length <= 4, 'Invalid cooking material slots', ErrorCode.GameConfig)
    const product = variants.values().next().value.product
    // One queue entry uses the base recipe's work budget. Reject grade variants
    // with different work/gates instead of silently charging a different cost.
    for (const variant of variants.values())
        for (const field of [
            'type',
            'group',
            'time',
            'satietyScore',
            'numberLimit',
            'unlockCondition',
            'isNeedPet',
            'notReleased',
        ])
            ensure(
                (variant.product[field] ?? 0) === (product[field] ?? 0),
                'Cooking grade variants disagree on queue rules',
                ErrorCode.GameConfig,
            )
    return { id, variants, requirements, product }
}

export function cookingSelection(recipe, items) {
    ensure(Array.isArray(items) && items.length > 0, 'Cooking materials are empty', ErrorCode.CookMaterialsNone)
    ensure(
        items.length === recipe.requirements.length,
        'Cooking material slot count does not match recipe',
        ErrorCode.CookMaterialNumNotMatch,
    )
    const supplied = new Map()
    let weight = 0,
        total = 0
    // Both current senders enumerate calculate slots, then uncalculate slots.
    // Keep slot identity; merging first hides malformed per-serving quantities.
    for (let i = 0; i < items.length; i++) {
        const item = items[i],
            requirement = recipe.requirements[i]
        ensure(positive(item?.item_id), 'Invalid cooking material identity', ErrorCode.CookMaterialFail)
        ensure(
            positive(item.item_num) && item.item_num === requirement.count,
            'Cooking material quantity does not match recipe',
            ErrorCode.CookMaterialNumFail,
        )
        const grade = requirement.grades.get(item.item_id)
        ensure(grade !== undefined, 'Cooking material is outside its configured group', ErrorCode.CookMaterialFail)
        const count = (supplied.get(item.item_id) ?? 0) + item.item_num
        ensure(positive(count), 'Cooking material overflow', ErrorCode.GameConfig)
        supplied.set(item.item_id, count)
        if (requirement.calculate) {
            weight += grade * requirement.count
            total += requirement.count
        }
    }
    ensure(Number.isSafeInteger(weight) && Number.isSafeInteger(total), 'Cooking grade overflow', ErrorCode.GameConfig)
    const baseGrade = total ? Math.floor(weight / total) : 0,
        remainder = total ? weight % total : 0
    ensure(recipe.variants.has(baseGrade), 'Cooking base grade is not configured', ErrorCode.CookMaterialQualityFail)
    ensure(
        !remainder || recipe.variants.has(baseGrade + 1),
        'Cooking upgrade grade is not configured',
        ErrorCode.GameConfig,
    )
    return { supplied, baseGrade, remainder, denominator: total || 1 }
}
export function cookingMaterials(recipe, items) {
    return cookingSelection(recipe, items).supplied
}

// The client explicitly displays Fraction as the next-star probability. Exact
// Bernoulli sampling and sealing at queue acceptance are local server policies;
// the official backend roll timing/rounding has not been observed.
export function cookingOutcomes(recipe, selection, count, randomInt) {
    ensure(
        positive(count) && count <= recipe.product.numberLimit,
        'Invalid cooking quantity',
        ErrorCode.CookNumMoreThanMax,
    )
    const units = []
    for (let i = 0; i < count; i++) {
        let grade = selection.baseGrade
        if (selection.remainder) {
            const roll = randomInt(selection.denominator)
            ensure(
                Number.isSafeInteger(roll) && roll >= 0 && roll < selection.denominator,
                'Invalid cooking random result',
                ErrorCode.InvalidLogic,
            )
            if (roll < selection.remainder) grade++
        }
        const variant = recipe.variants.get(grade)
        units.push({ grade, productId: variant.product.id, rewards: variant.rewards.map((reward) => ({ ...reward })) })
    }
    return units
}
