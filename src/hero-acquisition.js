import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

function countsFor(state) {
    const counts = state.heroAcquisitionCounts ?? state.gacha?.hero_counts ?? {}
    ensure(
        counts && typeof counts === 'object' && !Array.isArray(counts),
        'Invalid saved hero acquisition counts',
        ErrorCode.GameConfig,
    )
    return counts
}
export function nextHeroAcquisitionCount(state, id, owned) {
    const before = countsFor(state)[id] ?? (owned ? 1 : 0)
    ensure(
        Number.isInteger(before) && before >= (owned ? 1 : 0) && before < 0xffffffff,
        'Invalid saved hero acquisition count',
        ErrorCode.GameConfig,
    )
    return before + 1
}
export function recordHeroAcquisition(state, id, owned) {
    const next = nextHeroAcquisitionCount(state, id, owned),
        counts = countsFor(state)
    counts[id] = next
    state.heroAcquisitionCounts = counts
    if (state.gacha) state.gacha.hero_counts = counts
    return next
}
