import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function nextSoulRank(tables, state, item) {
    ensure(!item.zombie, 'Preview soul essence cannot advance', ErrorCode.SoulEssenceCantRankUp)
    ensure(
        tables.find('soulessence', item.id),
        'Soul essence configuration unavailable',
        ErrorCode.SoulEssenceConfNotExist,
    )
    ensure(
        Number.isInteger(item.rank) && item.rank >= 1 && Number.isInteger(item.lv) && item.lv >= 1,
        'Invalid saved soul essence rank',
        ErrorCode.GameConfig,
    )
    const ranks = tables
        .get('soulessence_rank')
        .filter((r) => r.relatedId === item.id)
        .sort((a, b) => a.rank - b.rank)
    ensure(
        ranks.length && ranks.every((r, i) => r.rank === i + 1),
        'Soul essence rank configuration unavailable or ambiguous',
        ErrorCode.SoulEssenceHadNotRank,
    )
    const current = ranks.find((r) => r.rank === item.rank)
    ensure(current, 'Soul essence has no corresponding rank', ErrorCode.SoulEssenceHadNotRank)
    ensure(item.rank < ranks.at(-1).rank, 'Soul essence maximum rank reached', ErrorCode.SoulEssenceMaxRank)
    ensure(
        Number.isSafeInteger(current.rankLevelLimit) && current.rankLevelLimit > 0,
        'Invalid soul essence rank level cap',
        ErrorCode.GameConfig,
    )
    ensure(
        item.lv === current.rankLevelLimit,
        'Reach the current soul essence level cap first',
        ErrorCode.SoulEssenceCantRankUp,
    )
    if (current.condition && current.condition !== '0') {
        const [kind, level, ...extra] = String(current.condition).split('|').map(Number)
        ensure(
            !extra.length && Number.isInteger(kind) && Number.isInteger(level) && level > 0,
            'Malformed soul essence rank prerequisite',
            ErrorCode.GameConfig,
        )
        ensure(kind === 2004, 'Soul essence rank prerequisite not implemented', ErrorCode.FunctionClosed)
        ensure(
            state.player.basic_info.lv >= level,
            'Player level too low for soul essence rank',
            ErrorCode.SoulEssenceRankUpPLv,
        )
    }
    ensure(
        Number.isSafeInteger(current.rankUpCoin) && current.rankUpCoin >= 0,
        'Invalid soul essence rank gold cost',
        ErrorCode.GameConfig,
    )
    const costs = new Map()
    for (const token of String(current.rankUpItem || '')
        .split('|')
        .filter(Boolean)) {
        // TDSoulessenceRank.rankUpItem is item-id/count, not reward triples.
        const [id, count, ...extra] = token.split('#').map(Number)
        ensure(
            !extra.length &&
                [id, count].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff) &&
                tables.find('common_item', id),
            'Invalid soul essence rank material',
            ErrorCode.GameConfig,
        )
        const total = (costs.get(id) ?? 0) + count
        ensure(
            Number.isSafeInteger(total) && total <= 0xffffffff,
            'Soul rank material cost overflow',
            ErrorCode.GameConfig,
        )
        costs.set(id, total)
    }
    return { rank: item.rank + 1, costs, gold: current.rankUpCoin }
}
