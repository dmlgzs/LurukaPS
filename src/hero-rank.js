import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'

// Lua worldLevelAction.getTaskMaxLevel and conditionNode_2009 use unlocked
// difficulty, independently of the player's selected world difficulty.
export function taskWorldLevel(tables, state) {
    let maximum = 1
    for (const row of tables
        .get('world_difficulty')
        .slice()
        .sort((a, b) => a.id - b.id)) {
        ensure(
            Number.isInteger(row.id) && row.id > 0 && Number.isInteger(row.taskId) && row.taskId >= 0,
            'Invalid world difficulty unlock configuration',
            ErrorCode.GameConfig,
        )
        if (!row.taskId || (state.taskRecords ?? []).some((r) => r.task_id === row.taskId && r.count > 0))
            maximum = row.id
    }
    return maximum
}
function condition(tables, state, text) {
    if (!text) return true
    const [kind, value, ...extra] = String(text).split('|').map(Number)
    ensure(
        !extra.length && Number.isInteger(kind) && Number.isInteger(value) && value >= 0,
        'Malformed hero rank condition',
        ErrorCode.GameConfig,
    )
    ensure(kind === 2009, 'Hero rank prerequisite not implemented', ErrorCode.FunctionClosed)
    return taskWorldLevel(tables, state) >= value
}
function runeIds(tables, row) {
    const ids = String(row.rankBreakthroughItem || '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    ensure(
        ids.length > 0 && ids.every((id) => Number.isInteger(id) && id > 0 && tables.find('talent_rune', id)),
        'Hero rank rune configuration unavailable',
        ErrorCode.HeroRankConfNotExist,
    )
    return ids
}
export function nextHeroRank(tables, state, hero) {
    ensure(
        Number.isInteger(hero.hero_rank) && hero.hero_rank >= 1 && Number.isInteger(hero.hero_lv) && hero.hero_lv >= 1,
        'Invalid saved hero rank progression',
        ErrorCode.GameConfig,
    )
    const rows = tables
        .get('talent_rank')
        .filter((row) => row.heroId === hero.conf_id)
        .sort((a, b) => a.rank - b.rank)
    ensure(
        rows.length > 0 && rows.every((row, index) => row.rank === index + 1),
        'Hero rank configuration unavailable or ambiguous',
        ErrorCode.HeroRankConfNotExist,
    )
    const current = rows.find((row) => row.rank === hero.hero_rank)
    ensure(current, 'Current hero rank configuration unavailable', ErrorCode.HeroRankConfNotExist)
    ensure(hero.hero_rank < rows.at(-1).rank, 'Hero rank limit reached', ErrorCode.HeroRankUpCheckFailed)
    const next = rows.find((row) => row.rank === hero.hero_rank + 1)
    ensure(
        Number.isInteger(next.rankLevelLimit) && next.rankLevelLimit >= 1,
        'Invalid hero rank level requirement',
        ErrorCode.GameConfig,
    )
    ensure(
        hero.hero_lv >= next.rankLevelLimit && condition(tables, state, next.condition),
        'Hero rank prerequisites not met',
        ErrorCode.HeroRankUpCheckFailed,
    )
    const ids = runeIds(tables, current),
        equipped = hero.rune_ids ?? []
    ensure(
        Array.isArray(equipped) &&
            equipped.length <= ids.length &&
            equipped.every((id) => Number.isInteger(id) && id >= 0 && id <= 0xffffffff),
        'Invalid saved hero rune slots',
        ErrorCode.GameConfig,
    )
    ensure(
        ids.every((id, slot) => equipped[slot] === id),
        'Equip all current hero rank runes first',
        ErrorCode.HeroRankUpCheckFailed,
    )
    const attrs = []
    for (const token of String(current.attribute || '')
        .split('|')
        .filter(Boolean)) {
        const [attr_id, attr_val, ...extra] = token.split('#').map(Number)
        ensure(
            !extra.length && [attr_id, attr_val].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff),
            'Invalid hero rank attribute gain',
            ErrorCode.GameConfig,
        )
        attrs.push({ attr_id, attr_val })
    }
    const costs = parseRewards(current.rankBreakthroughCoin)
    ensure(
        costs.every((row) => [3, 10].includes(row.itemtype)),
        'Hero rank cost category not implemented',
        ErrorCode.FunctionClosed,
    )
    return { rank: next.rank, slots: runeIds(tables, next).length, costs, attrs }
}
