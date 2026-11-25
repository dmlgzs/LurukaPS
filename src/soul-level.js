import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

// 1.0 SoulEssenceManager0600f66a/0600f66b derives the level cap from
// player-unlocked rank conditions, not from the legacy item.rank field.
export function soulLevelLimit(tables, state, item) {
    const rows = tables
        .get('soulessence_rank')
        .filter((row) => row.relatedId === item.id)
        .sort((a, b) => a.rank - b.rank)
    ensure(rows.length > 0, 'Soul rank configuration unavailable', ErrorCode.SoulEssenceHadNotRank)
    ensure(
        rows.every(
            (row, index) =>
                row.rank === index + 1 &&
                row.rank <= 8 &&
                Number.isSafeInteger(row.rankLevelLimit) &&
                row.rankLevelLimit > 0 &&
                (index === 0 || row.rankLevelLimit > rows[index - 1].rankLevelLimit),
        ),
        'Malformed soul level limit curve',
        ErrorCode.GameConfig,
    )
    ensure(
        Number.isInteger(item.rank) && rows.some((row) => row.rank === item.rank),
        'Invalid saved soul essence rank',
        ErrorCode.GameConfig,
    )
    const level = state.player.basic_info.lv
    ensure(Number.isSafeInteger(level) && level > 0, 'Invalid saved player level', ErrorCode.GameConfig)
    let selected = rows[0]
    for (const row of rows) {
        selected = row
        const condition = row.condition
        if (!condition || condition === '0') continue
        ensure(typeof condition === 'string', 'Malformed soul unlock condition', ErrorCode.GameConfig)
        const [kind, required, ...extra] = condition.split('|').map(Number)
        ensure(
            !extra.length && Number.isSafeInteger(kind) && Number.isSafeInteger(required) && required > 0,
            'Malformed soul unlock condition',
            ErrorCode.GameConfig,
        )
        ensure(kind === 2004, 'Soul level unlock condition is not implemented', ErrorCode.FunctionClosed)
        // The client includes the first blocked rank as its current level band.
        if (level < required) break
    }
    return { cap: selected.rankLevelLimit, unlockedRank: selected.rank }
}
