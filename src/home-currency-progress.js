import { readHomeCurrencyAcquisition } from './home-currency-acquisition.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const sourceKey = 'home-currency-acquisition:global:10:103'
export function homeCurrencyProgressRule(tables, tokens) {
    if (
        !Array.isArray(tokens) ||
        tokens.length !== 4 ||
        tokens[0] !== 12029 ||
        tokens[1] !== 10 ||
        tokens[2] !== 103 ||
        !tokens.every(Number.isSafeInteger) ||
        tokens[3] <= 0 ||
        tokens[3] > 0xffffffff
    )
        return false
    ensure(
        tables.get('currency').filter((row) => row.id === 103).length === 1,
        'Home currency acquisition definition unavailable or duplicated',
        ErrorCode.GameConfig,
    )
    return true
}

export function homeCurrencyProgressValue(tables, state, tokens, facts) {
    if (!homeCurrencyProgressRule(tables, tokens)) return null
    let total
    if (facts?.has(sourceKey)) total = facts.get(sourceKey)
    else {
        total = readHomeCurrencyAcquisition(state)
        facts?.set(sourceKey, total)
    }
    const target = BigInt(tokens[3])
    return Number(total > target ? target : total)
}
