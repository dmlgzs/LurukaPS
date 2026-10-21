import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

// Only successful capture receipts are evidence of historical catches. The
// sandbox's prefilled pet box and GM grants must not become capture progress.
export function noviceCounters(state) {
    state.noviceCounters ??= {
        captures: Object.values(state.petCaptureResults ?? {}).filter((r) => r.guid && r.pet_id > 0).length,
        staminaSpent: 0,
    }
    for (const value of Object.values(state.noviceCounters))
        ensure(Number.isSafeInteger(value) && value >= 0, 'Invalid novice counter', ErrorCode.GameConfig)
    return state.noviceCounters
}
export function recordNoviceCounter(state, key, amount) {
    const counters = noviceCounters(state)
    ensure(['captures', 'staminaSpent'].includes(key), 'Unknown novice counter', ErrorCode.GameConfig)
    ensure(
        Number.isSafeInteger(amount) && amount > 0 && Number.isSafeInteger(counters[key] + amount),
        'Novice counter overflow',
        ErrorCode.GameConfig,
    )
    counters[key] += amount
}
