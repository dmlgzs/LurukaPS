import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'
import { ornamentValueTables } from './ornament-values.js'

const levels = new WeakMap(),
    mains = new WeakMap()
export function nextOrnamentLevel(external, item) {
    const tables = ornamentValueTables(external),
        config = tables.find('accessory', item.id)
    ensure(config, 'Ornament configuration unavailable', ErrorCode.OrnamentConfFail)
    ensure(Number.isSafeInteger(item.lv) && item.lv >= 0, 'Invalid saved ornament level', ErrorCode.GameConfig)
    if (!levels.has(tables)) levels.set(tables, new Map())
    const byItem = levels.get(tables)
    if (!byItem.has(item.id)) {
        const entries = new Map()
        for (const row of tables.get('accessory_level')) {
            if (row.accessoryId !== item.id) continue
            ensure(
                Number.isSafeInteger(row.level) && row.level >= 0,
                'Invalid ornament level configuration',
                ErrorCode.AccessoryLevelUpConfFail,
            )
            if (entries.has(row.level)) {
                const first = entries.get(row.level)
                ensure(
                    [
                        'accessoryId',
                        'rarity',
                        'level',
                        'slot',
                        'item',
                        'return_item',
                        'unlock_entry',
                        'smelt_point',
                    ].every((key) => JSON.stringify(first[key]) === JSON.stringify(row[key])),
                    'Conflicting ornament level configuration',
                    ErrorCode.AccessoryLevelUpConfFail,
                )
                continue // Current table repeats 50 identical levels under other Id values.
            }
            entries.set(row.level, row)
        }
        byItem.set(item.id, entries)
    }
    const entries = levels.get(tables).get(item.id)
    ensure(entries?.size, 'Ornament level configuration unavailable', ErrorCode.AccessoryLevelUpConfFail)
    const current = entries.get(item.lv),
        maximum = Math.max(...entries.keys())
    ensure(current && item.lv <= maximum, 'Saved ornament level not configured', ErrorCode.AccessoryLevelUpConfFail)
    ensure(item.lv < maximum, 'Ornament is at maximum level', ErrorCode.OrnamentMaxLv)
    const next = entries.get(item.lv + 1)
    ensure(
        next && current.rarity === config.rarity && next.rarity === config.rarity,
        'Ornament next level unavailable',
        ErrorCode.AccessoryLevelUpConfFail,
    )
    if (!mains.has(tables)) {
        const byLevel = new Map()
        for (const row of tables.get('accessory_main')) {
            const key = row.groupId + ':' + row.level
            if (!byLevel.has(key)) byLevel.set(key, [])
            byLevel.get(key).push(row)
        }
        mains.set(tables, byLevel)
    }
    const attrs = mains.get(tables).get(config.mainAttr + ':' + next.level)
    ensure(
        attrs?.length &&
            attrs.every(
                (row) =>
                    Number.isSafeInteger(Number(String(row.battleInfo).split('|')[0])) &&
                    Number(String(row.battleInfo).split('|')[0]) > 0 &&
                    Number.isSafeInteger(row.value),
            ),
        'Ornament next attributes unavailable',
        ErrorCode.OrnamentConfFail,
    )
    const costs = parseRewards(current.item)
    ensure(
        costs.every((cost) => [3, 10].includes(cost.itemtype)),
        'Ornament upgrade cost category not implemented',
        ErrorCode.FunctionClosed,
    )
    return { level: next.level, costs }
}
