import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Local policy: HomeDrop's unweighted List<int> selects one uniform list slot.
// The current10087 text proves one random candidate and total10/hour, not the
// official relative weights. TODO: replace only with authoritative weights.
export function collectionDropIds(tables, drop) {
    const raw = String(drop.itemId ?? '')
    ensure(
        [3, 10, 14].includes(drop.itemType) && /^\d+(\|\d+)*$/.test(raw),
        `Invalid collection drop identity list (drop ${drop.id})`,
        ErrorCode.GameConfig,
    )
    const ids = raw.split('|').map(Number)
    ensure(
        ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff) && new Set(ids).size === ids.length,
        `Invalid collection drop candidate (drop ${drop.id})`,
        ErrorCode.GameConfig,
    )
    const table = drop.itemType === 3 ? 'common_item' : drop.itemType === 10 ? 'currency' : 'pet_egg'
    ensure(
        ids.every((id) => tables.find(table, id)),
        `Collection drop candidate configuration is missing (drop ${drop.id})`,
        ErrorCode.GameConfig,
    )
    return ids
}
export const collectionItemMatches = (item, product, type, id) =>
    item.source_product_id === product && item.item_type === type && item.item_id === id

export function collectionPending(stream, value) {
    if (value === undefined) return undefined
    if (typeof value === 'number') {
        ensure(
            stream.itemIds.length === 1 && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
            'Invalid legacy collection pending drop',
            ErrorCode.GameConfig,
        )
        return { item_id: stream.itemIds[0], item_type: stream.drop.itemType, item_num: value }
    }
    ensure(
        value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            value.item_type === stream.drop.itemType &&
            stream.itemIds.includes(value.item_id) &&
            Number.isSafeInteger(value.item_num) &&
            value.item_num >= 0 &&
            value.item_num <= 0xffffffff,
        'Invalid saved collection pending candidate',
        ErrorCode.GameConfig,
    )
    return value
}
