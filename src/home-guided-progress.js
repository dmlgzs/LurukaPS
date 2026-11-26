import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { readTable } from './table-source.js'

const orders = new Map(readTable('home_exchange_order').map((row) => [row.orderID, row]))
const uint = (value) => Number.isSafeInteger(value) && value >= 0
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
function progress(state) {
    const value = state.homeExchange?.taskProgress
    if (value === undefined) {
        const exchange = state.homeExchange,
            terminal = exchange?.settlementReceipt,
            validSale =
                record(terminal) &&
                ['manual', 'scheduled'].includes(terminal.kind) &&
                uint(terminal.time) &&
                terminal.time > 0 &&
                uint(terminal.day) &&
                uint(terminal.principal) &&
                terminal.principal > 0 &&
                uint(terminal.extra),
            counts = {}
        ensure(
            exchange?.orderReceipts === undefined || record(exchange.orderReceipts),
            'Invalid terminal home order receipts',
            ErrorCode.GameConfig,
        )
        // These are terminal producer receipts, not the lossy UI history or
        // an old aggregate. Only retained, individually identifiable orders
        // with matching current config/tier and positive completion time count.
        for (const [key, receipt] of Object.entries(exchange?.orderReceipts ?? {})) {
            const row = orders.get(receipt?.id)
            if (
                !/^[1-9]\d*$/.test(key) ||
                !Number.isSafeInteger(Number(key)) ||
                Number(key) > 0xffffffff ||
                !row ||
                receipt.level !== row.orderLevel ||
                !uint(receipt.time) ||
                receipt.time <= 0
            )
                continue
            counts[row.orderID] = (counts[row.orderID] ?? 0) + 1
        }
        return { version: 1, sales: validSale ? 1 : 0, orders: counts }
    }
    ensure(
        record(value) && value.version === 1 && uint(value.sales) && record(value.orders),
        'Invalid home transaction task progress',
        ErrorCode.GameConfig,
    )
    for (const [key, count] of Object.entries(value.orders))
        ensure(
            /^[1-9]\d*$/.test(key) && Number.isSafeInteger(Number(key)) && uint(count),
            'Invalid home order task progress',
            ErrorCode.GameConfig,
        )
    return value
}

// These counters originate only at successful business commits or validated
// retained terminal receipts. Old wallet, financial history, order totals and
// GM grants are not completion evidence.
export function recordHomeGuidedSale(state) {
    ensure(record(state.homeExchange), 'Home exchange task state unavailable', ErrorCode.GameConfig)
    const old = progress(state),
        sales = old.sales + 1
    ensure(uint(sales), 'Home sale task progress overflow', ErrorCode.GameConfig)
    state.homeExchange.taskProgress = { ...old, sales }
}
export function recordHomeGuidedOrder(tables, state, orderId) {
    ensure(record(state.homeExchange), 'Home exchange task state unavailable', ErrorCode.GameConfig)
    ensure(
        Number.isSafeInteger(orderId) &&
            orderId > 0 &&
            tables.get('home_exchange_order').some((row) => row.orderID === orderId),
        'Home order task configuration unavailable',
        ErrorCode.HomeOrderConfInvalid,
    )
    const old = progress(state),
        count = (old.orders[orderId] ?? 0) + 1
    ensure(uint(count), 'Home order task progress overflow', ErrorCode.GameConfig)
    state.homeExchange.taskProgress = { ...old, orders: { ...old.orders, [orderId]: count } }
}

export function homeGuidedConditionValue(tokens, state) {
    if (tokens[0] === 16091 && tokens.length === 2 && uint(tokens[1]) && tokens[1] > 0)
        return Math.min(tokens[1], progress(state).sales)
    if (tokens[0] === 16089 && tokens.length === 3 && orders.has(tokens[1]) && uint(tokens[2]) && tokens[2] > 0)
        return Math.min(tokens[2], progress(state).orders[tokens[1]] ?? 0)
    return null
}
