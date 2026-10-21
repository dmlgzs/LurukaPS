import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'

const indices = new WeakMap()
function options(tables) {
    if (!indices.has(tables)) {
        const index = new Map()
        for (const row of tables.get('products_material_group')) {
            // This table's key is capitalized Id. select_material sends this
            // key, not itemId, groupId or the UI's zero-based array position.
            ensure(
                Number.isInteger(row.Id) && row.Id > 0 && !index.has(row.Id),
                'Invalid production material option identity',
                ErrorCode.GameConfig,
            )
            index.set(row.Id, row)
        }
        indices.set(tables, index)
    }
    return indices.get(tables)
}
export function productionMaterials(tables, recipe, selected = []) {
    const groups = String(recipe.materialSelect || '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    ensure(
        groups.every((id) => Number.isInteger(id) && id > 0),
        'Invalid production material groups',
        ErrorCode.GameConfig,
    )
    ensure(
        Array.isArray(selected) && selected.length === groups.length,
        'Production material choice count does not match recipe',
        ErrorCode.ProductSelectMaterialFail,
    )
    const costs = parseRewards(recipe.material)
    const index = groups.length ? options(tables) : null
    for (let position = 0; position < groups.length; position++) {
        const id = selected[position],
            row = index.get(id)
        ensure(
            Number.isInteger(id) && id > 0 && row?.materialGroupId === groups[position],
            'Production material choice is outside its configured group',
            ErrorCode.ProductSelectMaterialFail,
        )
        const material = parseRewards(row.material)
        ensure(material.length === 1, 'Invalid production material option', ErrorCode.GameConfig)
        costs.push(...material)
    }
    const merged = new Map()
    for (const cost of costs) {
        const key = `${cost.itemtype}:${cost.itemid}`
        const previous = merged.get(key)
        const total = (previous?.itemnum ?? 0) + cost.itemnum
        ensure(
            Number.isSafeInteger(total) && total <= 0xffffffff,
            'Production material cost overflow',
            ErrorCode.GameConfig,
        )
        merged.set(key, { ...cost, itemnum: total })
    }
    return [...merged.values()]
}
