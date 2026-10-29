import fs from 'node:fs'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const stacks = new Map(
    JSON.parse(fs.readFileSync(new URL('../configs/inventory-tables/common_item.json', import.meta.url))).map((row) => [
        row.id,
        row.stackNum,
    ]),
)
const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff

export function ranchItem(tables, item) {
    ensure(item && typeof item === 'object' && !Array.isArray(item), 'Invalid ranch item shape', ErrorCode.GameConfig)
    ensure(
        [3, 10].includes(item.itemtype) && positive(item.itemid) && positive(item.itemnum),
        'Invalid typed ranch item',
        ErrorCode.GameConfig,
    )
    if (item.itemtype === 3) {
        ensure(
            stacks.has(item.itemid) && (!tables || tables.find('common_item', item.itemid)),
            'Unknown reward item in ranch storage',
            ErrorCode.GameConfig,
        )
    } else ensure(tables?.find('currency', item.itemid), 'Unknown ranch currency', ErrorCode.GameConfig)
    return { itemtype: item.itemtype, itemid: item.itemid, itemnum: item.itemnum }
}

// Pure whole-warehouse projection: validate every row before any source moves.
export function ranchStoreItems(tables, stores) {
    ensure(Array.isArray(stores), 'Invalid ranch storage list', ErrorCode.GameConfig)
    const items = new Map()
    for (const row of stores) {
        const item = ranchItem(tables, row),
            key = `${item.itemtype}:${item.itemid}`
        const previous = items.get(key)
        if (previous) {
            ensure(previous.itemnum + item.itemnum <= 0xffffffff, 'Ranch stored amount overflow', ErrorCode.GameConfig)
            previous.itemnum += item.itemnum
        } else items.set(key, item)
    }
    return [...items.values()]
}

export function ranchItemSlots(item) {
    if (item.itemtype === 10) return 1 // Human-approved local policy: one merged currency row, not one slot per coin.
    const stack = stacks.get(item.itemid)
    ensure(Number.isSafeInteger(stack) && stack >= 0, 'Invalid ranch storage stack configuration', ErrorCode.GameConfig)
    return stack > 0 ? Math.ceil(item.itemnum / stack) : 1
}
