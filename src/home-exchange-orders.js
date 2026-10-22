import { randomInt } from 'node:crypto'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { homeCondition } from './home-grid.js'
import { ensureHomeExchange, exchangeClock } from './home-exchange.js'
const catalogues = new WeakMap()
export function exchangeOrderCatalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const orders = tables.get('home_exchange_order'),
        byId = new Map(orders.map((r) => [r.orderID, r]))
    ensure(
        orders.length && orders.length === byId.size,
        'Exchange order configuration unavailable',
        ErrorCode.HomeOrderConfInvalid,
    )
    const types = tables.get('home_exchange_order_type'),
        groups = new Map()
    for (const row of types) {
        ensure(
            Number.isInteger(row.orderTime) &&
                row.orderTime >= 1 &&
                row.orderTime <= 7 &&
                Number.isInteger(row.orderPeriod) &&
                row.orderPeriod > 0 &&
                row.orderPeriod % 86400 === 0 &&
                Number.isInteger(row.orderLevel) &&
                row.orderLevel > 0 &&
                Number.isInteger(row.orderNum) &&
                row.orderNum >= 0,
            'Invalid exchange order period or tier',
            ErrorCode.GameConfig,
        )
        let group = groups.get(row.orderTime)
        if (!group) groups.set(row.orderTime, (group = { weekday: row.orderTime, period: row.orderPeriod, tiers: [] }))
        ensure(
            group.period === row.orderPeriod && !group.tiers.some((r) => r.orderLevel === row.orderLevel),
            'Conflicting exchange order periods',
            ErrorCode.GameConfig,
        )
        group.tiers.push(row)
    }
    const refreshes = Number(tables.get('game').find((r) => r.title === 'ORDER_PERIOD_REFRESH')?.value)
    ensure(
        Number.isInteger(refreshes) && refreshes >= 0 && refreshes <= 0xffffffff,
        'Invalid order refresh allowance',
        ErrorCode.GameConfig,
    )
    const result = { orders, byId, groups: [...groups.values()], refreshes }
    catalogues.set(tables, result)
    return result
}
export function exchangeOrderWindow(tables, now) {
    const { businessDay } = exchangeClock(tables, now),
        weekday = ((businessDay + 3) % 7) + 1
    const hour = Number(tables.get('game').find((r) => r.title === 'DAILY_REFRESH_TIME').value)
    // Local compatibility: interpret orderTime as ISO weekday. Current 3/6
    // windows and their table periods cover the whole week without overlap.
    const windows = exchangeOrderCatalogue(tables)
        .groups.map((group) => {
            const day = businessDay - ((weekday - group.weekday + 7) % 7),
                start = day * 86400 - 8 * 3600 + hour * 3600
            return { ...group, start, end: start + group.period }
        })
        .filter((w) => w.start <= now && now < w.end)
    ensure(windows.length === 1, 'Exchange order schedule is missing or ambiguous', ErrorCode.HomeOrderConfInvalid)
    return windows[0]
}
export function orderCandidates(tables, state, level, exclude = new Set()) {
    return exchangeOrderCatalogue(tables).orders.filter(
        (row) => row.orderLevel === level && !exclude.has(row.orderID) && homeCondition(row.orderUnlock, state),
    )
}
function allocate(exchange, slots) {
    let next = exchange.nextOrderGuid ?? 1
    ensure(Number.isSafeInteger(next) && next > 0, 'Invalid exchange order identity counter', ErrorCode.GameConfig)
    next = Math.max(next, ...slots.map((s) => (s.guid ?? 0) + 1))
    ensure(next <= 0xffffffff, 'Exchange order identity exhausted', ErrorCode.GameConfig)
    exchange.nextOrderGuid = next + 1
    return next
}
export function ensureExchangeOrderBoard(c) {
    const exchange = ensureHomeExchange(c.tables, c.state, c.now, c.randomInt),
        window = exchangeOrderWindow(c.tables, c.now)
    let board = exchange.board
    if (!board || board.start !== window.start || board.end !== window.end) {
        board = exchange.board = {
            start: window.start,
            end: window.end,
            refreshes: exchangeOrderCatalogue(c.tables).refreshes,
            slots: window.tiers
                .toSorted((a, b) => a.orderLevel - b.orderLevel)
                .flatMap((row) => Array.from({ length: row.orderNum }, () => ({ level: row.orderLevel }))),
        }
    }
    const used = new Set(board.slots.filter((s) => s.order_id).map((s) => s.order_id)),
        rng = c.randomInt ?? randomInt
    for (const slot of board.slots) {
        if (slot.guid || slot.done) continue
        const pool = orderCandidates(c.tables, c.state, slot.level, used)
        if (!pool.length) continue // Keep a never-offered slot for a later level unlock.
        const row = pool[rng(0, pool.length)]
        slot.guid = allocate(exchange, board.slots)
        slot.order_id = row.orderID
        used.add(row.orderID)
    }
    return board
}
export function exchangeOrderSnapshot(state, rewards = []) {
    const board = state.homeExchange.board
    return {
        base: {
            start_time: board.start,
            end_time: board.end,
            refresh_times: board.refreshes,
            order_guid: board.slots
                .filter((s) => s.guid && !s.done)
                .map((s) => ({ guid: s.guid, order_id: s.order_id })),
        },
        rewards,
    }
}
