import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'
import { ornamentEntryEffects } from './ornament-entry-effects.js'

export function ornamentStarPlan(tables, state, request) {
    const target = state.ornaments?.find((item) => item.guid === request.target_guid)
    ensure(target, 'Ornament not owned', ErrorCode.OrnamentNotExist)
    const config = tables.find('accessory', target.id)
    ensure(config, 'Ornament configuration unavailable', ErrorCode.OrnamentConfFail)
    const grade = target.grade === undefined ? 0 : target.grade
    ensure(Number.isSafeInteger(grade) && grade >= 0, 'Invalid saved ornament star', ErrorCode.GameConfig)
    const rows = tables.get('accessory_upgrade').filter((row) => row.rarity === config.rarity)
    ensure(
        rows.length && rows.every((row) => Number.isSafeInteger(row.grade) && row.grade > 0),
        'Ornament star configuration unavailable',
        ErrorCode.GameConfig,
    )
    const maximum = Math.max(...rows.map((row) => row.grade))
    ensure(grade <= maximum, 'Saved ornament star exceeds configured maximum', ErrorCode.GameConfig)
    ensure(grade < maximum, 'Ornament is at maximum star')
    const next = rows.filter((row) => row.grade === grade + 1)
    ensure(
        next.length === 1 && Number.isSafeInteger(next[0].count) && next[0].count > 0,
        'Ornament next star configuration unavailable',
        ErrorCode.GameConfig,
    )
    const ids = request.material_guids ?? []
    ensure(
        ids.length === next[0].count && new Set(ids).size === ids.length && !ids.includes(target.guid),
        'Invalid ornament star materials',
    )
    const materials = ids.map((guid) => {
        const item = state.ornaments.find((item) => item.guid === guid)
        ensure(item, 'Ornament material not owned', ErrorCode.OrnamentNotExist)
        ensure(!item.lock, 'Ornament material is locked', ErrorCode.LockOrnament)
        ensure(
            (!item.wear_hero || item.wear_hero === '0') &&
                !state.player.heros_info.heros.some((hero) => hero.oguid?.includes(guid)),
            'Ornament material is equipped',
            ErrorCode.EquipOrnament,
        )
        ensure(item.id === target.id, 'Ornament material must be the same item')
        const materialGrade = item.grade === undefined ? 0 : item.grade
        ensure(
            Number.isSafeInteger(materialGrade) && materialGrade >= 0,
            'Invalid material ornament star',
            ErrorCode.GameConfig,
        )
        ensure(materialGrade === 0, 'Upgraded ornament cannot be a star material', ErrorCode.OrnamentUpgradeFail)
        const level = item.lv === undefined ? 0 : item.lv
        ensure(Number.isSafeInteger(level) && level >= 0, 'Invalid material ornament level', ErrorCode.GameConfig)
        return item
    })
    const rewards = materials.flatMap((item) => {
        const row = tables
            .get('accessory_level')
            .find((row) => row.accessoryId === item.id && row.level === (item.lv === undefined ? 0 : item.lv))
        ensure(row, 'Ornament material return configuration unavailable', ErrorCode.AccessoryLevelUpConfFail)
        return parseRewards(row.return_item)
    })
    ensure(
        rewards.every((item) => [3, 10].includes(item.itemtype)),
        'Ornament star return category not implemented',
        ErrorCode.FunctionClosed,
    )
    const costs = parseRewards(next[0].cost)
    ensure(
        costs.every((item) => [3, 10].includes(item.itemtype)),
        'Ornament star cost category not implemented',
        ErrorCode.FunctionClosed,
    )
    ornamentEntryEffects(tables, [{ ...target, grade: next[0].grade }])
    return { target, grade: next[0].grade, consumed: new Set(ids), costs, rewards }
}
