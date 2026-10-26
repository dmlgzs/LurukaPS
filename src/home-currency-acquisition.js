import policy from '../configs/home-currency-acquisition-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const adminDrafts = new WeakSet()
const warned = new Set()
const maximum = 0xffffffffffffffffn
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
ensure(
    policy.schemaVersion === 1 &&
        policy.basis === 'user-selected-all-normal-103-rewards' &&
        policy.officiallyVerified === false &&
        policy.namespace === 'global-player-attributes' &&
        policy.resourceType === 10 &&
        policy.resourceId === 103 &&
        policy.unit === 'actual-credited-normal-reward-leaves' &&
        JSON.stringify(policy.excludedIntents) === '["admin","refund"]' &&
        policy.legacyBalanceBackfill === false &&
        policy.legacyOtherCountersBackfill === false &&
        policy.counterLimit === 'uint64-saturate-with-diagnostic' &&
        policy.unknownIntent === 'preserve-reward-skip-counter-and-diagnose' &&
        policy.unknownVersion === 'preserve-reward-and-counter-skip-new-counts',
    'Invalid home currency acquisition policy',
    ErrorCode.GameConfig,
)

function warnOnce(state, reason) {
    const accountId = state.player?.basic_info?.id ?? 0
    const key = accountId + ':' + reason
    if (warned.has(key)) return
    warned.add(key)
    while (warned.size > 256) warned.delete(warned.values().next().value)
    try {
        console.warn(
            '[home-currency-acquisition]',
            JSON.stringify({
                accountId,
                reason,
                resourceType: 10,
                resourceId: 103,
                action: 'preserve-normal-financial-result-no-history-inference',
            }),
        )
    } catch {
        // Diagnostics cannot turn an unclassified acquisition into lost money.
    }
}

// Identity is the current transaction draft, not a saved account or a session.
// The normal next request receives a different draft and cannot retain this tag.
export function markAdminAcquisitionDraft(state) {
    ensure(object(state), 'Invalid acquisition transaction draft', ErrorCode.GameConfig)
    adminDrafts.add(state)
}

export function refundAcquisitionContext(context = {}) {
    return { ...context, homeCurrencyAcquisitionIntent: 'refund' }
}

export function homeCurrencyAcquisitionIntent(state, context = {}) {
    if (adminDrafts.has(state)) return 'admin'
    const value = context?.homeCurrencyAcquisitionIntent ?? 'normal'
    if (['normal', 'refund', 'admin'].includes(value)) return value
    warnOnce(state, 'unknown-intent')
    return null
}

function counter(state) {
    const value = state.homeCurrencyAcquisition
    if (value === undefined) return { total: 0n }
    if (!object(value) || value.version !== 1) {
        warnOnce(state, 'unknown-counter-version')
        return null
    }
    ensure(
        value.resourceType === 10 &&
            value.resourceId === 103 &&
            typeof value.total === 'string' &&
            value.total.length <= 20 &&
            /^(0|[1-9]\d*)$/.test(value.total) &&
            BigInt(value.total) <= maximum,
        'Malformed typed home currency acquisition counter',
        ErrorCode.GameConfig,
    )
    return { total: BigInt(value.total) }
}

// Called only after a successful global10:103 credit. This does not observe
// display rewards, account balance changes, event attrs, or an optional src ID.
export function recordCreditedHomeCurrency(state, type, id, amount, context = {}) {
    if (type !== policy.resourceType || id !== policy.resourceId) return false
    ensure(uint(amount) && amount > 0, 'Invalid credited home currency amount', ErrorCode.GameConfig)
    if (homeCurrencyAcquisitionIntent(state, context) !== 'normal') return false
    const old = counter(state)
    if (!old) return false
    const sum = old.total + BigInt(amount)
    if (sum > maximum) warnOnce(state, 'counter-limit-saturated')
    const total = sum > maximum ? maximum : sum
    if (total === old.total) return false
    // A small fresh record never aliases an earlier deferred transaction.
    state.homeCurrencyAcquisition = { version: 1, resourceType: 10, resourceId: 103, total: String(total) }
    return true
}

export function readHomeCurrencyAcquisition(state) {
    return counter(state)?.total ?? 0n
}
