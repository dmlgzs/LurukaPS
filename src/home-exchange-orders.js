import { randomInt } from 'node:crypto'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { recordActiveProgress } from './daily-active.js'
import { homeCondition } from './home-grid.js'
import { ensureHomeExchange, exchangeClock } from './home-exchange.js'
import { parseRewards, grantRewards } from './rewards.js'
import { spend } from './inventory.js'
import { rewardSource } from './reward-source.js'
import { recordHomeOrderCompletion } from './home-order-progress.js'
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
function rememberOrderSequence(exchange, slots) {
    let next = exchange.nextOrderGuid === undefined ? 1 : exchange.nextOrderGuid
    ensure(
        Number.isSafeInteger(next) && next > 0 && next <= 0x100000000 && Array.isArray(slots),
        'Invalid exchange order identity counter',
        ErrorCode.GameConfig,
    )
    const ids = new Set()
    for (const slot of slots) {
        const guid = slot.guid === undefined ? 0 : slot.guid
        ensure(
            Number.isInteger(guid) && guid >= 0 && guid <= 0xffffffff && (!guid || !ids.has(guid)),
            'Invalid saved exchange order identity',
            ErrorCode.GameConfig,
        )
        if (guid) ids.add(guid)
        next = Math.max(next, guid + 1)
    }
    const receipts = exchange.orderReceipts ?? {}
    ensure(
        receipts && typeof receipts === 'object' && !Array.isArray(receipts),
        'Invalid exchange order receipt identities',
        ErrorCode.GameConfig,
    )
    for (const id of Object.keys(receipts)) {
        const guid = Number(id)
        ensure(
            Number.isInteger(guid) && guid > 0 && guid <= 0xffffffff && String(guid) === id,
            'Invalid exchange order receipt identity',
            ErrorCode.GameConfig,
        )
        next = Math.max(next, guid + 1)
    }
    // UInt32+1 is only a persisted exhausted sentinel, never a wire identity.
    exchange.nextOrderGuid = next
    return next
}
function allocate(exchange, slots) {
    const next = rememberOrderSequence(exchange, slots)
    ensure(next <= 0xffffffff, 'Exchange order identity exhausted', ErrorCode.GameConfig)
    exchange.nextOrderGuid = next + 1
    return next
}
export function ensureExchangeOrderBoard(c) {
    const exchange = ensureHomeExchange(c.tables, c.state, c.now, c.randomInt),
        window = exchangeOrderWindow(c.tables, c.now)
    let board = exchange.board
    if (!board || board.start !== window.start || board.end !== window.end) {
        // Preserve unsubmitted old live identities before replacing the board;
        // a legacy missing counter must not make stale client requests reusable.
        rememberOrderSequence(exchange, board?.slots ?? [])
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
export function refreshExchangeOrder(c, r) {
    ensure(Number.isInteger(r.order_guid) && r.order_guid > 0 && r.order_guid <= 0xffffffff, 'Invalid order identity')
    const board = ensureExchangeOrderBoard(c),
        slot = board.slots.find((s) => s.guid === r.order_guid && !s.done)
    ensure(slot, 'Exchange order was not found', ErrorCode.HomeOrderNotExists)
    ensure(board.refreshes > 0, 'Exchange order refresh allowance exhausted', ErrorCode.ExchangeOrderNotRefershTime)
    const current = exchangeOrderCatalogue(c.tables).byId.get(slot.order_id)
    ensure(
        current?.orderLevel === slot.level,
        'Exchange order tier configuration changed',
        ErrorCode.HomeOrderConfInvalid,
    )
    const excluded = new Set(board.slots.map((s) => s.order_id).filter(Boolean)),
        pool = orderCandidates(c.tables, c.state, slot.level, excluded)
    ensure(pool.length, 'No alternative unlocked order of this tier', ErrorCode.HomeOrderRefreshNoChange)
    slot.order_id = pool[(c.randomInt ?? randomInt)(0, pool.length)].orderID
    board.refreshes--
    return exchangeOrderSnapshot(c.state)
}
export function exchangeOrderPlan(tables, state, row, now) {
    ensure(row, 'Exchange order configuration unavailable', ErrorCode.HomeOrderConfigNotExists)
    ensure(homeCondition(row.orderUnlock, state), 'Exchange order is locked', ErrorCode.HomeOrderNotOpen)
    const costs = parseRewards(row.orderNeedMaterials),
        rewards = parseRewards(row.orderReward),
        reputation = parseRewards(row.orderReputation)
    ensure(
        costs.length && costs.every((r) => r.itemtype === 3),
        'Exchange order material type is not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(
        reputation.every((r) => r.itemtype === 29 && tables.find('groups', r.itemid)),
        'Invalid exchange order reputation configuration',
        ErrorCode.GameConfig,
    )
    const mallSetting = (title) => tables.get('mall_game').find((r) => r.title === title)?.value
    const card = state.monthlyCard,
        monthly = card?.end_time > now && card.purchase_sdk_id === Number(mallSetting('MONTHLY_CADR_PURCHASE_SDK_ID'))
    if (monthly) {
        const items = String(mallSetting('MONTHLY_CADR_HOME_BUFF_ITEM'))
                .split('|')
                .map((value) => value.split('#').map(Number)),
            rates = String(mallSetting('MONTHLY_CADR_HOME_BUFF_VALUE')).split('|').map(Number)
        ensure(
            items.length === rates.length &&
                items.every((pair) => pair.length === 2 && pair.every((n) => Number.isInteger(n) && n > 0)) &&
                rates.every((rate) => Number.isInteger(rate) && rate >= 0),
            'Monthly order benefit configuration unavailable',
            ErrorCode.GameConfig,
        )
        for (const reward of rewards) {
            const index = items.findIndex(([type, id]) => reward.itemtype === type && reward.itemid === id)
            if (index >= 0) reward.itemnum += Math.floor((reward.itemnum * rates[index]) / 10000)
        }
    }
    return { costs, rewards: [...rewards, ...reputation] }
}
export function submitExchangeOrder(c, r) {
    ensure(
        Number.isInteger(r.order_guid) && r.order_guid > 0 && r.order_guid <= 0xffffffff,
        'Invalid exchange order identity',
    )
    const board = ensureExchangeOrderBoard(c),
        exchange = c.state.homeExchange
    if (exchange.orderReceipts?.[r.order_guid]) return exchangeOrderSnapshot(c.state)
    const slot = board.slots.find((s) => s.guid === r.order_guid && !s.done)
    ensure(slot, 'Exchange order was not found', ErrorCode.HomeOrderNotExists)
    const row = exchangeOrderCatalogue(c.tables).byId.get(slot.order_id)
    ensure(row?.orderLevel === slot.level, 'Exchange order tier configuration changed', ErrorCode.HomeOrderConfInvalid)
    const plan = exchangeOrderPlan(c.tables, c.state, row, c.now)
    const costs = new Map()
    for (const cost of plan.costs) costs.set(cost.itemid, (costs.get(cost.itemid) ?? 0) + cost.itemnum)
    spend(c.state, costs, 0, c.now)
    const rewards = grantRewards(c.tables, c.state, plan.rewards)
    slot.done = true
    const receipts = (exchange.orderReceipts ??= {})
    receipts[r.order_guid] = { id: slot.order_id, time: c.now, level: row.orderLevel }
    const keys = Object.keys(receipts).sort((a, b) => Number(a) - Number(b))
    for (const key of keys.slice(0, Math.max(0, keys.length - 256))) delete receipts[key]
    recordHomeOrderCompletion(c.tables, c.state, row.orderLevel)
    recordActiveProgress(c.tables, c.state, 15003, 1, c.now)
    c.pushBefore('CSProtoSyncPlayerData', {
        basic_info: c.state.player.basic_info,
        attr_infos: c.state.player.attr_infos,
        sbag_infos: c.state.player.sbag_infos,
    })
    return exchangeOrderSnapshot(c.state, [{ rewards, src: rewardSource(c.tables, 'exchangeOrderSubmit') }])
}
