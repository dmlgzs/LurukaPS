import { homeOrderProgressRule, homeOrderProgressValue } from './home-order-progress.js'

// 1.0.0 Journey uses HomeOrder(13099, selector=0, count) for cumulative
// trading-station order submissions. The former journey selector15003 also
// supports tiers; only its existing all-tier ledger is shared here. No legacy
// configuration is loaded, and no unknown13099 selector is treated as total.
function cumulative(tokens) {
    if (
        tokens.length !== 3 ||
        tokens[0] !== 13099 ||
        tokens[1] !== 0 ||
        !Number.isInteger(tokens[2]) ||
        tokens[2] <= 0 ||
        tokens[2] > 0xffffffff
    )
        return null
    return [15003, 0, 0, tokens[2]]
}

export function journeyHomeOrderRule(tables, tokens) {
    const normalized = cumulative(tokens)
    return normalized !== null && homeOrderProgressRule(tables, normalized)
}

export function journeyHomeOrderValue(tables, state, tokens, facts = new Map()) {
    const normalized = cumulative(tokens)
    return normalized === null ? null : homeOrderProgressValue(tables, state, normalized, facts)
}
