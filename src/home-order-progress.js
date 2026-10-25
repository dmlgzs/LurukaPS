import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import policy from '../configs/home-order-progress-policy.json' with { type: 'json' }

const catalogues = new WeakMap()
const uint = (n) => Number.isSafeInteger(n) && n >= 0
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
function levels(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    ensure(
        policy.version === 1 && policy.condition === 15003 && policy.creditOn === 'successful-order-submission',
        'Home order progress policy unavailable',
        ErrorCode.GameConfig,
    )
    const rows = tables.get('home_exchange_order'),
        ids = new Set(),
        result = new Set()
    ensure(rows.length > 0, 'Home order progress configuration unavailable', ErrorCode.HomeOrderConfInvalid)
    for (const row of rows) {
        ensure(
            Number.isInteger(row.orderID) &&
                row.orderID > 0 &&
                row.orderID <= 0xffffffff &&
                !ids.has(row.orderID) &&
                Number.isInteger(row.orderLevel) &&
                row.orderLevel > 0 &&
                row.orderLevel <= 0xffffffff,
            'Invalid home order progress configuration',
            ErrorCode.GameConfig,
        )
        ids.add(row.orderID)
        result.add(row.orderLevel)
    }
    catalogues.set(tables, result)
    return result
}
function progress(tables, state) {
    const savedTotal = state.homeExchange?.completedOrders,
        total = savedTotal === undefined ? 0 : savedTotal
    ensure(uint(total), 'Invalid completed home order total', ErrorCode.GameConfig)
    const saved = state.homeExchange?.orderProgress
    if (saved === undefined) return { total, legacyTotal: total, counts: {}, revision: 0 }
    ensure(
        record(saved) && saved.version === 1 && uint(saved.legacyTotal) && uint(saved.revision) && record(saved.counts),
        'Invalid home order progress ledger',
        ErrorCode.GameConfig,
    )
    const valid = levels(tables)
    let count = 0
    for (const [key, value] of Object.entries(saved.counts)) {
        const level = Number(key)
        ensure(
            String(level) === key && valid.has(level) && uint(value),
            'Invalid saved home order tier count',
            ErrorCode.GameConfig,
        )
        count += value
        ensure(uint(count), 'Home order progress overflow', ErrorCode.GameConfig)
    }
    ensure(
        count === saved.revision && uint(saved.legacyTotal + count) && saved.legacyTotal + count === total,
        'Home order total and typed history disagree',
        ErrorCode.GameConfig,
    )
    return { total, legacyTotal: saved.legacyTotal, counts: saved.counts, revision: saved.revision }
}
export function recordHomeOrderCompletion(tables, state, level) {
    ensure(levels(tables).has(level), 'Invalid completed home order tier', ErrorCode.HomeOrderConfInvalid)
    const old = progress(tables, state),
        total = old.total + 1,
        revision = old.revision + 1
    ensure(uint(total) && uint(revision), 'Home order progress overflow', ErrorCode.GameConfig)
    const count = (old.counts[level] ?? 0) + 1
    ensure(uint(count), 'Home order tier progress overflow', ErrorCode.GameConfig)
    state.homeExchange.orderProgress = {
        version: 1,
        legacyTotal: old.legacyTotal,
        counts: { ...old.counts, [level]: count },
        revision,
    }
    state.homeExchange.completedOrders = total
}
export function homeOrderProgressRule(tables, tokens) {
    return (
        tokens.length === 4 &&
        tokens[0] === 15003 &&
        tokens[1] === 0 &&
        Number.isInteger(tokens[2]) &&
        tokens[2] >= 0 &&
        (tokens[2] === 0 || levels(tables).has(tokens[2])) &&
        uint(tokens[3]) &&
        tokens[3] > 0
    )
}
export function homeOrderProgressValue(tables, state, tokens, facts = new Map()) {
    if (!homeOrderProgressRule(tables, tokens)) return null
    if (!facts.has('home:orders')) facts.set('home:orders', progress(tables, state))
    const current = facts.get('home:orders')
    return Math.min(tokens[3], tokens[2] === 0 ? current.total : (current.counts[tokens[2]] ?? 0))
}
