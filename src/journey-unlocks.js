import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const parse = (text) =>
    String(text || '')
        .split('|')
        .filter(Boolean)
        .map((rule) => rule.split('#').map(Number))
export function compileJourneyUnlocks(tables, text) {
    return parse(text).map((rule) => {
        ensure(rule.every(uint), 'Malformed journey unlock configuration', ErrorCode.JourneyConfError)
        if (rule[0] === 15017)
            ensure(
                rule.length === 2 && rule[1] > 0 && tables.find('home_level', rule[1]),
                'Invalid journey home level selector',
                ErrorCode.JourneyConfError,
            )
        if (rule[0] === 61001)
            ensure(
                rule.length === 3 &&
                    rule[1] > 0 &&
                    rule[2] > 0 &&
                    tables
                        .get('reputation_level')
                        .some((row) => row.reputationId === rule[1] && row.reputationlevel === rule[2]),
                'Invalid journey reputation selector',
                ErrorCode.JourneyConfError,
            )
        //12042 requires the authoritative lock/banning ledger; table conditions alone do not prove it.
        return rule
    })
}

export function journeyReputationFacts(model, state) {
    return new Map(
        model.sourceReputationIds.map((id) => {
            const value = state.reputations?.[id]?.level ?? 0
            ensure(uint(value), 'Malformed journey reputation level', ErrorCode.GameConfig)
            return [id, value]
        }),
    )
}
