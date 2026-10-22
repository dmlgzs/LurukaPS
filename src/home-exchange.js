import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'
import { randomInt } from 'node:crypto'
import { spend } from './inventory.js'

export function exchangeItemConfig(tables, id) {
    ensure(Number.isInteger(id) && id > 0 && id <= 0xffffffff, 'Invalid exchange item ID')
    const row = exchangeCatalogue(tables).items.get(id)
    ensure(row, 'Exchange item configuration unavailable', ErrorCode.ExchangeItemNoExist)
    ensure(
        Number.isSafeInteger(row.price) && row.price > 0 && Number.isSafeInteger(row.itemId) && row.itemId > 0,
        'Invalid exchange price or item reference',
        ErrorCode.GameConfig,
    )
    ensure(row.type === 3, 'Exchange instance type is not implemented', ErrorCode.FunctionClosed)
    ensure(
        tables.find('common_item', row.itemId),
        'Exchange inventory item configuration unavailable',
        ErrorCode.GameConfig,
    )
    return row
}
export function exchangeUnitPrice(tables, state, id) {
    const row = exchangeItemConfig(tables, id),
        change = state.homeExchange.market.changes[id] ?? 0
    ensure(
        Number.isInteger(change) && Number.isInteger(row.bonusRate),
        'Invalid exchange price modifier',
        ErrorCode.GameConfig,
    )
    const value = Math.trunc((row.price * (100 + change + row.bonusRate)) / 100)
    ensure(
        Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff,
        'Invalid exchange unit price',
        ErrorCode.GameConfig,
    )
    return value
}
export function reserveExchangeItem(c, r) {
    const clock = exchangeClock(c.tables, c.now)
    ensure(!clock.away, 'Merchant is away until daily reset', ErrorCode.InvalidLogic)
    const row = exchangeItemConfig(c.tables, r.id)
    ensure(r.type === row.type && !r.guid, 'Exchange item type or instance does not match')
    ensure(Number.isInteger(r.num) && r.num > 0 && r.num <= 0xffffffff, 'Invalid exchange quantity')
    const exchange = ensureHomeExchange(c.tables, c.state, c.now, c.randomInt)
    ensure(
        exchange.box.every((e) => e.day === clock.businessDay),
        'A previous shipment is awaiting settlement',
        ErrorCode.InvalidLogic,
    )
    const price = exchangeUnitPrice(c.tables, c.state, r.id)
    const reserved = exchange.box.reduce((n, e) => n + e.num * e.unitPrice, 0),
        cost = r.num * price
    ensure(
        Number.isSafeInteger(reserved) && Number.isSafeInteger(cost),
        'Exchange value overflow',
        ErrorCode.GameConfig,
    )
    ensure(
        exchangeWeeklyIncome(c.tables, c.state, c.now) + reserved + cost <= exchangeCatalogue(c.tables).limit,
        'Exchange weekly income limit exceeded',
        ErrorCode.ExchangeSettleLimit,
    )
    const old = exchange.box.find((e) => e.id === r.id)
    ensure(!old || old.unitPrice === price, 'Shipment quote changed before settlement', ErrorCode.GameConfig)
    const before = new Map(
        c.state.player.sbag_infos.items.filter((i) => i.itemid === row.itemId).map((i) => [i.guid, { ...i }]),
    )
    const changed = spend(c.state, new Map([[row.itemId, r.num]]), 0, c.now)
    const items = changed.map((stack) => ({
        ...before.get(stack.guid),
        itemnum: before.get(stack.guid).itemnum - stack.itemnum,
    }))
    const entry = old ?? {
        id: r.id,
        num: 0,
        items: [],
        unitPrice: price,
        day: clock.businessDay,
        shippingAt: clock.shippingAt,
        settleAt: clock.settleAt,
    }
    entry.num += r.num
    entry.items.push(...items)
    ensure(
        Number.isSafeInteger(entry.num) && entry.num <= 0xffffffff,
        'Exchange shipment quantity overflow',
        ErrorCode.GameConfig,
    )
    if (!old) exchange.box.push(entry)
    delete exchange.cancelReceipts?.[r.id]
    delete exchange.manualReceipt
    return entry
}

const catalogues = new WeakMap()
const list = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export function exchangeCatalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const game = (title) => tables.get('game').find((row) => row.title === title)?.value
    const resetHour = Number(game('DAILY_REFRESH_TIME')),
        limit = Number(game('HOME_EXCHANGE_SELL_LIMIT'))
    const increase = list(game('HOME_EXCHANGE_EVENT_INCREASE')),
        drops = Number(game('HOME_EXCHANGE_EVENT_DROP_NUM'))
    ensure(
        Number.isInteger(resetHour) && resetHour >= 0 && resetHour < 24 && Number.isSafeInteger(limit) && limit > 0,
        'Invalid exchange clock or income limit',
        ErrorCode.GameConfig,
    )
    ensure(
        increase.length === 2 && increase.every(Number.isSafeInteger) && increase[0] >= 0 && increase[1] >= increase[0],
        'Invalid exchange price range',
        ErrorCode.GameConfig,
    )
    ensure(drops === 0, 'Exchange price decreases are not implemented', ErrorCode.FunctionClosed)
    const bar = tables.get('ui_top_bar').find((row) => row.viewName === 'PageHomeExchangeSell')
    const resources = list(bar?.resourceBar)
    ensure(resources.length === 1, 'Exchange currency UI binding unavailable', ErrorCode.GameConfig)
    const currency = tables.find('resource_bar_item', resources[0])
    ensure(
        currency?.resourceType === 10 && tables.find('currency', currency.resourceID),
        'Exchange currency configuration unavailable',
        ErrorCode.GameConfig,
    )
    const items = new Map(tables.get('home_exchange_item').map((row) => [row.id, row]))
    ensure(
        items.size === tables.get('home_exchange_item').length,
        'Duplicate exchange item configuration',
        ErrorCode.GameConfig,
    )
    const events = tables.get('home_exchange_event')
    ensure(
        events.length && new Set(events.map((row) => row.EventId)).size === events.length,
        'Exchange news configuration unavailable',
        ErrorCode.GameConfig,
    )
    const result = { resetHour, limit, increase, currency: currency.resourceID, items, events }
    catalogues.set(tables, result)
    return result
}
export function exchangeClock(tables, now) {
    const { resetHour } = exchangeCatalogue(tables),
        zone = 8 * 3600
    ensure(Number.isInteger(now) && now > 0 && now <= 0xffffffff, 'Invalid exchange time', ErrorCode.GameConfig)
    const day = Math.floor((now + zone) / 86400),
        businessDay = Math.floor((now + zone - resetHour * 3600) / 86400)
    return {
        day,
        businessDay,
        start: day * 86400 - zone,
        shippingAt: (businessDay + 1) * 86400 - zone,
        settleAt: (businessDay + 1) * 86400 - zone + resetHour * 3600,
        weekStart: businessDay - ((businessDay + 3) % 7),
        away: (now + zone) % 86400 < resetHour * 3600,
    }
}
export function ensureHomeExchange(tables, state, now, rng = randomInt) {
    const config = exchangeCatalogue(tables),
        clock = exchangeClock(tables, now)
    const exchange = (state.homeExchange ??= { history: [], box: [], pendingNotice: { rewards: [] } })
    exchange.history ??= []
    exchange.box ??= []
    ensure(
        Array.isArray(exchange.history) && Array.isArray(exchange.box),
        'Invalid exchange storage',
        ErrorCode.GameConfig,
    )
    if (exchange.market?.day !== clock.businessDay) {
        const eligible = config.events.filter((row) => homeCondition(row.EventUnlock, state))
        ensure(eligible.length, 'No unlocked exchange market event', ErrorCode.FunctionClosed)
        const pick = (rows) => rows[rng(0, rows.length)]
        const old = exchange.market
        const event =
            (old?.day === clock.businessDay - 1 && eligible.find((row) => row.EventId === old.nextEventId)) ||
            pick(eligible)
        const next = pick(eligible.length > 1 ? eligible.filter((row) => row !== event) : eligible)
        const tags = list(event.PriceIncreaseTag),
            changes = {}
        for (const row of config.items.values())
            if (list(row.Tag).some((tag) => tags.includes(tag)))
                changes[row.id] = rng(config.increase[0], config.increase[1] + 1)
        exchange.market = { day: clock.businessDay, eventId: event.EventId, nextEventId: next.EventId, tags, changes }
    }
    return exchange
}
export function exchangeWeeklyIncome(tables, state, now) {
    const { weekStart } = exchangeClock(tables, now)
    let value = 0
    for (const record of state.homeExchange?.history ?? []) {
        const day = Math.floor((record.history_time + 8 * 3600) / 86400)
        if (day >= weekStart && day < weekStart + 7) value += record.profit
    }
    ensure(
        Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
        'Invalid exchange weekly income',
        ErrorCode.GameConfig,
    )
    return value
}
export function exchangeNewsSnapshot(state) {
    const market = state.homeExchange.market
    return {
        nowEventId: market.eventId,
        NextEventId: market.nextEventId,
        tag: market.tags,
        cinfo: Object.entries(market.changes).map(([id, value]) => ({
            objid: Number(id),
            isupper: value >= 0,
            percent: Math.abs(value),
        })),
    }
}
export function exchangeBoxSnapshot(tables, state, now) {
    return {
        obj_info: (state.homeExchange?.box ?? []).map((row) => ({ id: row.id, num: row.num })),
        settle_num: exchangeWeeklyIncome(tables, state, now),
    }
}

export function exchangeHistorySnapshot(state, consumeNotice = false) {
    const exchange = state.homeExchange
    const info = (exchange?.history ?? [])
        .map((record) => {
            const result = {}
            for (const field of ['history_time', 'profit', 'settle_num', 'extra_num']) {
                const value = record[field] ?? 0
                ensure(
                    Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
                    'Invalid saved exchange history',
                    ErrorCode.GameConfig,
                )
                result[field] = value
            }
            return result
        })
        .sort((a, b) => a.history_time - b.history_time)
    const award = structuredClone(exchange?.pendingNotice ?? { rewards: [] })
    // Awards were already delivered by settlement. This is a UI notice only,
    // never a second invocation of grantRewards when reading the report.
    if (consumeNotice && award.rewards?.length) exchange.pendingNotice = { rewards: [] }
    return { info, extra_info: { award } }
}
