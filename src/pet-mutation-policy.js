import selected from '../configs/pet-mutation-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

function freeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child)
        Object.freeze(value)
    }
    return value
}
ensure(
    selected.version === 3 &&
        selected.localStrategy === true &&
        selected.officiallyVerified === false &&
        selected.userApproved === true &&
        selected.source?.earningFailurePolicy?.humanApproval === true &&
        selected.runtimeEnabled === false,
    'Mutation private model lacks its approved rule binding',
    ErrorCode.GameConfig,
)
const policy = freeze(selected)
const creditLimits = new WeakMap()
export function mutationPolicy() {
    return policy
}
export function mutationCreditLimits(tables) {
    if (creditLimits.has(tables)) return creditLimits.get(tables)
    const rows = tables.get('game').filter((r) => r.title === 'KIBO_DNA_MUTATION_TIMES_LIMIT')
    const cap = rows.length === 1 ? Number(rows[0].value) : NaN
    ensure(
        Number.isSafeInteger(cap) && cap > 0 && cap <= 0xffffffff,
        'Invalid mutation credit cap configuration',
        ErrorCode.GameConfig,
    )
    const step = policy.source.staminaPerTrial
    ensure(
        Number.isSafeInteger(step) && step > 0 && step <= 0xffffffff,
        'Invalid approved mutation remainder unit',
        ErrorCode.GameConfig,
    )
    const result = Object.freeze({ cap, step })
    creditLimits.set(tables, result)
    return result
}
