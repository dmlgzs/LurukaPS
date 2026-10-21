import currentReturns from '../configs/ornament-smelt-values/values.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'

const overrides = new Map(currentReturns.map((row) => [row.id, row.smeltReturn])),
    levels = new WeakMap()
function levelReturn(tables, item) {
    const level = item.lv === undefined ? 0 : item.lv
    ensure(Number.isSafeInteger(level) && level >= 0, 'Invalid saved ornament level', ErrorCode.GameConfig)
    if (!levels.has(tables)) {
        const byItem = new Map()
        for (const row of tables.get('accessory_level')) {
            const key = row.accessoryId + ':' + row.level
            if (!byItem.has(key)) byItem.set(key, [])
            byItem.get(key).push(row)
        }
        levels.set(tables, byItem)
    }
    const matches = levels.get(tables).get(item.id + ':' + level)
    ensure(matches?.length, 'Ornament level return unavailable', ErrorCode.OrnamentConfFail)
    ensure(
        matches.every((row) => row.return_item === matches[0].return_item),
        'Conflicting ornament level return',
        ErrorCode.GameConfig,
    )
    ensure(typeof matches[0].return_item === 'string', 'Invalid ornament level return', ErrorCode.GameConfig)
    return parseRewards(matches[0].return_item)
}

export function ornamentSmeltPlan(tables, state, guids) {
    // ModuleItemDecompose.AddSelectedItemByGuid (06012963), current client.
    ensure(
        Array.isArray(guids) && guids.length > 0 && guids.length <= 500 && new Set(guids).size === guids.length,
        'Invalid or duplicate ornament smelt selection',
    )
    const owned = new Map((state.ornaments ?? []).map((item) => [item.guid, item])),
        selected = new Set(),
        rewards = new Map()
    const add = (reward, times = 1) => {
        const key = reward.itemtype + ':' + reward.itemid,
            previous = rewards.get(key)
        const total = (previous?.itemnum ?? 0) + reward.itemnum * times
        ensure(
            Number.isSafeInteger(total) && total > 0 && total <= 0xffffffff,
            'Ornament smelt reward overflow',
            ErrorCode.GameConfig,
        )
        rewards.set(key, { ...reward, itemnum: total })
    }
    for (const guid of guids) {
        ensure(Number.isSafeInteger(guid) && guid > 0 && guid <= 0xffffffff, 'Invalid ornament identity')
        const item = owned.get(guid)
        ensure(item, 'Ornament not owned', ErrorCode.OrnamentNotExist)
        ensure(!item.lock, 'Ornament is locked', ErrorCode.LockOrnament)
        ensure(
            (!item.wear_hero || item.wear_hero === '0') &&
                !state.player.heros_info.heros.some((hero) => hero.oguid?.includes(guid)),
            'Ornament is equipped',
            ErrorCode.EquipOrnament,
        )
        const config = tables.find('accessory', item.id)
        ensure(config, 'Ornament configuration unavailable', ErrorCode.OrnamentConfFail)
        const grade = item.grade === undefined ? 0 : item.grade
        ensure(Number.isSafeInteger(grade) && grade >= 0, 'Invalid saved ornament star', ErrorCode.GameConfig)
        const upgrades = tables.get('accessory_upgrade').filter((row) => row.rarity === config.rarity)
        ensure(
            upgrades.length && upgrades.every((row) => Number.isSafeInteger(row.grade) && row.grade > 0),
            'Ornament star configuration unavailable',
            ErrorCode.OrnamentConfFail,
        )
        ensure(
            grade <= Math.max(...upgrades.map((row) => row.grade)),
            'Saved ornament star exceeds configuration',
            ErrorCode.GameConfig,
        )
        let copies = 1
        for (let star = 1; star <= grade; star++) {
            const rows = upgrades.filter((row) => row.grade === star)
            ensure(
                rows.length === 1 && Number.isSafeInteger(rows[0].count) && rows[0].count > 0,
                'Ornament star material count unavailable',
                ErrorCode.OrnamentConfFail,
            )
            copies += rows[0].count
            ensure(
                Number.isSafeInteger(copies) && copies <= 0xffffffff,
                'Ornament smelt copy count overflow',
                ErrorCode.GameConfig,
            )
        }
        for (const reward of levelReturn(tables, item)) add(reward)
        // BuildRewardEntries (06012970) uses template rarity to resolve star
        // counts. Instance quality is unrelated; strengthened returns are once.
        const text = overrides.has(item.id) ? overrides.get(item.id) : config.smeltReturn
        ensure(typeof text === 'string', 'Invalid ornament base return', ErrorCode.GameConfig)
        const base = parseRewards(text)
        for (const reward of base) add(reward, copies)
        selected.add(guid)
    }
    return { selected, rewards: [...rewards.values()] }
}
