import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'
import { randomInt } from 'node:crypto'
import { spend } from './inventory.js'
import { refreshAutoCropShortcut } from './home.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
import exchangePolicy from '../configs/home-exchange-policy.json' with { type: 'json' }

function settleShipment(tables, state, now, kind, shipment) {
    const exchange = state.homeExchange,
        box = shipment ?? exchange?.box ?? []
    if (!box.length) return null
    const first = box[0],
        config = exchangeCatalogue(tables)
    let principal = 0,
        quantity = 0
    for (const entry of box) {
        ensure(
            Number.isInteger(entry.num) && entry.num > 0 && Number.isInteger(entry.unitPrice) && entry.unitPrice > 0,
            'Invalid saved exchange quantity or quote',
            ErrorCode.GameConfig,
        )
        ensure(
            entry.day === first.day &&
                entry.settleAt === first.settleAt &&
                Number.isInteger(entry.day) &&
                Number.isInteger(entry.settleAt),
            'Mixed exchange departure windows',
            ErrorCode.GameConfig,
        )
        ensure(
            entry.items?.length &&
                entry.items.every(
                    (item) =>
                        Number.isInteger(item.itemid) &&
                        item.itemid > 0 &&
                        item.itemid === entry.items[0].itemid &&
                        Number.isInteger(item.itemnum) &&
                        item.itemnum > 0,
                ) &&
                entry.items.reduce((n, item) => n + item.itemnum, 0) === entry.num,
            'Invalid shipment inventory proof',
            ErrorCode.GameConfig,
        )
        principal += entry.num * entry.unitPrice
        quantity += entry.num
    }
    ensure(
        [principal, quantity].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff),
        'Exchange settlement overflow',
        ErrorCode.GameConfig,
    )
    let extra = 0,
        extras = []
    if (kind === 'scheduled') {
        const tiers = tables
            .get('home_exchange_sell_extrareward')
            .filter((row) => row.SellNum <= quantity)
            .sort((a, b) => b.SellNum - a.SellNum)
        ensure(tiers.length, 'Exchange extra reward configuration unavailable', ErrorCode.GameConfig)
        const tier = tiers[0]
        ensure(
            Number.isInteger(tier.YieldIncreases) && tier.YieldIncreases >= 0 && tier.YieldIncreases <= 10000,
            'Invalid exchange extra income rate',
            ErrorCode.GameConfig,
        )
        extra = Math.floor((principal * tier.YieldIncreases) / 10000)
        extras = parseRewards(tier.ItemReward)
    }
    const rewards = grantRewards(tables, state, [
        { itemtype: 10, itemid: config.currency, itemnum: principal + extra },
        ...extras,
    ])
    const dayTime = first.day * 86400 - 8 * 3600 + config.resetHour * 3600
    const history = (exchange.history ??= []),
        old = history.find((row) => row.history_time === dayTime)
    const record = old ?? { history_time: dayTime, profit: 0, settle_num: 0, extra_num: 0 }
    record.profit += principal
    record.settle_num += quantity
    record.extra_num += extra
    ensure(
        Object.values(record).every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff),
        'Exchange financial report overflow',
        ErrorCode.GameConfig,
    )
    if (!old) history.push(record)
    // UI requests a recent-date chart; 90 days is a local retention policy.
    exchange.history = history.sort((a, b) => a.history_time - b.history_time).slice(-90)
    if (kind === 'manual') exchange.box = []
    exchange.settlementReceipt = { kind, time: now, day: first.day, principal, extra }
    const award = { rewards, src: rewardSource(tables, 'exchangeSale') }
    if (kind === 'scheduled')
        exchange.pendingNotice = { rewards: [...(exchange.pendingNotice?.rewards ?? []), ...rewards], src: award.src }
    return award
}
export function settleExchangeImmediately(c) {
    if (!c.state.homeExchange?.box?.length) {
        ensure(c.state.homeExchange?.settlementReceipt, 'No goods in the shipment box', ErrorCode.ExchangeNoItem)
        return { rewards: [] }
    }
    return settleShipment(c.tables, c.state, c.now, 'manual')
}
export function homeExchangeDue(tables, state, now) {
    const exchange = state.homeExchange
    if (!exchange) return exchangeEligibleEvents(tables, state).length > 0
    return (
        exchange.marketChecked !== exchangeMarketKey(tables, state, now) ||
        (exchange.box ?? []).some((row) => row.shippingAt <= now) ||
        (exchange.shipments ?? []).some((row) => row.settleAt <= now)
    )
}
export function prepareHomeExchange(c, { publish = true, historyNotice = true } = {}) {
    const previousMarket = c.state.homeExchange?.market
    if (!c.state.homeExchange && !exchangeEligibleEvents(c.tables, c.state).length) return false
    const exchange = (c.state.homeExchange ??= { history: [], box: [], pendingNotice: { rewards: [] } })
    // The page counts down to midnight, then says the merchant is away until
    // 04:00. Its add/cancel callbacks remain available. Move departed goods
    // out of the editable box and let new bookings target the next departure.
    const departing = (exchange.box ?? []).filter((row) => row.shippingAt <= c.now)
    if (departing.length) {
        exchange.shipments ??= []
        for (const entry of departing) {
            let batch = exchange.shipments.find((b) => b.settleAt === entry.settleAt && b.day === entry.day)
            if (!batch) exchange.shipments.push((batch = { day: entry.day, settleAt: entry.settleAt, items: [] }))
            batch.items.push(entry)
        }
        exchange.box = exchange.box.filter((row) => !departing.includes(row))
    }
    const due = (exchange.shipments ?? []).filter((row) => row.settleAt <= c.now)
    for (const batch of due) settleShipment(c.tables, c.state, c.now, 'scheduled', batch.items)
    if (due.length) exchange.shipments = exchange.shipments.filter((row) => !due.includes(row))
    ensureHomeExchange(c.tables, c.state, c.now, c.randomInt)
    const marketChanged = previousMarket !== exchange.market
    if (publish) {
        if (due.length) {
            c.pushBefore('CSProtoSyncPlayerData', {
                basic_info: c.state.player.basic_info,
                attr_infos: c.state.player.attr_infos,
                sbag_infos: c.state.player.sbag_infos,
            })
            if (historyNotice)
                c.pushBefore('CSProtoSCHomeExchangeInfo', { history: exchangeHistorySnapshot(c.state, true) })
        }
        if (marketChanged && !exchange.marketUnavailable)
            c.pushBefore('CSProtoHomeExchangeNewInfo', exchangeNewsSnapshot(c.state))
        if (due.length || departing.length || marketChanged)
            c.pushBefore('CSProtoSCHomeexchanceObj', exchangeBoxSnapshot(c.tables, c.state, c.now))
    }
    return !!due.length || !!departing.length || marketChanged
}
export function homeExchangeLoginData(tables, state, now) {
    if (!state.homeExchange) return []
    return [
        ...(!state.homeExchange.marketUnavailable && state.homeExchange.market
            ? [['CSProtoHomeExchangeNewInfo', exchangeNewsSnapshot(state)]]
            : []),
        ['CSProtoSCHomeexchanceObj', exchangeBoxSnapshot(tables, state, now)],
        ['CSProtoSCHomeExchangeInfo', { history: exchangeHistorySnapshot(state, true) }],
    ]
}

export function returnExchangeReservation(c, r) {
    const clock = exchangeClock(c.tables, c.now)
    ensure(Number.isInteger(r.id) && r.id > 0 && r.id <= 0xffffffff, 'Invalid exchange item ID')
    ensure(!r.guid, 'Exchange material must not specify an instance')
    const exchange = c.state.homeExchange,
        entries = exchange?.box?.filter((e) => e.id === r.id) ?? []
    if (!entries.length && exchange?.cancelReceipts?.[r.id] === clock.day) return false
    ensure(entries.length, 'Exchange reservation was not found', ErrorCode.ExchangeCancelNotFind)
    ensure(
        entries.every((e) => e.shippingAt > c.now),
        'Shipment is already in transit',
        ErrorCode.InvalidLogic,
    )
    const bag = c.state.player.sbag_infos.items,
        byGuid = new Map(bag.map((i) => [i.guid, i])),
        restored = new Map()
    let total = 0
    for (const item of entries.flatMap((entry) => entry.items ?? [])) {
        ensure(
            c.tables.find('common_item', item.itemid) &&
                (item.itemtype ?? 3) === 3 &&
                Number.isInteger(item.itemnum) &&
                item.itemnum > 0,
            'Invalid exchange reservation record',
            ErrorCode.GameConfig,
        )
        ensure(
            /^\d+$/.test(String(item.guid)) && BigInt(item.guid) > 0n && BigInt(item.guid) <= 0xffffffffffffffffn,
            'Invalid reserved inventory identity',
            ErrorCode.GameConfig,
        )
        const current = byGuid.get(item.guid)
        ensure(
            !current || (current.itemid === item.itemid && (current.deadtime ?? 0) === (item.deadtime ?? 0)),
            'Reserved inventory identity conflicts with the bag',
            ErrorCode.GameConfig,
        )
        const result = restored.get(item.guid) ?? { ...(current ?? item), itemnum: current?.itemnum ?? 0 }
        result.itemnum += item.itemnum
        total += item.itemnum
        ensure(
            Number.isSafeInteger(result.itemnum) && result.itemnum <= 0xffffffff,
            'Restored exchange quantity overflow',
            ErrorCode.GameConfig,
        )
        restored.set(item.guid, result)
    }
    ensure(
        total === entries.reduce((n, e) => n + e.num, 0),
        'Exchange reservation quantity does not match',
        ErrorCode.GameConfig,
    )
    for (const [guid, item] of restored) {
        const old = byGuid.get(guid)
        if (old) Object.assign(old, item)
        else bag.push(item)
        const next = BigInt(c.state.nextItemGuid ?? '1')
        if (BigInt(guid) >= next) c.state.nextItemGuid = String(BigInt(guid) + 1n)
    }
    exchange.box = exchange.box.filter((e) => !entries.includes(e))
    const receipts = (exchange.cancelReceipts ??= {})
    receipts[r.id] = clock.day
    for (const [id, day] of Object.entries(receipts)) if (day !== clock.day) delete receipts[id]
    for (const itemId of new Set([...restored.values()].map((item) => item.itemid)))
        refreshAutoCropShortcut(c.tables, c.state, itemId)
    return true
}

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
    ensure(
        state.homeExchange?.market && !state.homeExchange.marketUnavailable,
        'Exchange market is not open',
        ErrorCode.FunctionClosed,
    )
    const row = exchangeItemConfig(tables, id),
        change = state.homeExchange.market.changes[id] ?? 0
    ensure(
        Number.isInteger(change) && (row.bonusRate === undefined || Number.isInteger(row.bonusRate)),
        'Invalid exchange price modifier',
        ErrorCode.GameConfig,
    )
    const value =
        row.bonusRate === undefined
            ? Math.ceil((row.price * (100 + change)) / 100)
            : Math.trunc((row.price * (100 + change + row.bonusRate)) / 100)
    ensure(
        Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff,
        'Invalid exchange unit price',
        ErrorCode.GameConfig,
    )
    return value
}
export function reserveExchangeItem(c, r) {
    const clock = exchangeClock(c.tables, c.now)
    const row = exchangeItemConfig(c.tables, r.id)
    ensure(r.type === row.type && !r.guid, 'Exchange item type or instance does not match')
    ensure(Number.isInteger(r.num) && r.num > 0 && r.num <= 0xffffffff, 'Invalid exchange quantity')
    const exchange = ensureHomeExchange(c.tables, c.state, c.now, c.randomInt)
    ensure(
        exchange.box.every((e) => e.shippingAt > c.now),
        'A previous shipment is awaiting settlement',
        ErrorCode.InvalidLogic,
    )
    const price = exchangeUnitPrice(c.tables, c.state, r.id)
    const weekStart = clock.day - ((clock.day + 3) % 7)
    const allReservations = [...exchange.box, ...(exchange.shipments ?? []).flatMap((batch) => batch.items)]
    const reserved = allReservations
            .filter((e) => e.day >= weekStart && e.day < weekStart + 7)
            .reduce((n, e) => n + e.num * e.unitPrice, 0),
        cost = r.num * price
    ensure(
        Number.isSafeInteger(reserved) && Number.isSafeInteger(cost),
        'Exchange value overflow',
        ErrorCode.GameConfig,
    )
    ensure(
        exchangeIncomeForWeek(c.state, weekStart) + reserved + cost <= exchangeCatalogue(c.tables).limit,
        'Exchange weekly income limit exceeded',
        ErrorCode.ExchangeSettleLimit,
    )
    const old = exchange.box.find((e) => e.id === r.id && e.day === clock.day && e.unitPrice === price)
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
        day: clock.day,
        shippingAt: (clock.day + 1) * 86400 - 8 * 3600,
        settleAt: (clock.day + 1) * 86400 - 8 * 3600 + exchangeCatalogue(c.tables).resetHour * 3600,
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
    const currentRanges = events.every((row) => !String(row.EventUnlock).includes('#'))
    ensure(
        currentRanges
            ? events.every((row) => list(row.EventUnlock).length === 2)
            : events.every((row) => String(row.EventUnlock).includes('#')),
        'Mixed or malformed exchange event unlock schema',
        ErrorCode.GameConfig,
    )
    const first = currentRanges ? list(game('HOME_EXCHANGE_FIRST')) : []
    ensure(
        !currentRanges || (first.length === 3 && first.every((n) => Number.isInteger(n) && n > 0)),
        'Invalid first exchange configuration',
        ErrorCode.GameConfig,
    )
    const firstChanges = currentRanges
        ? String(game('HOME_EXCHANGE_FIRST_INCREASE') ?? '')
              .split('|')
              .filter((token) => token.trim())
              .map((token) => token.split('#').map(Number))
        : []
    ensure(
        firstChanges.every(
            ([id, upper, percent, ...rest]) =>
                !rest.length && items.has(id) && [0, 1].includes(upper) && Number.isInteger(percent) && percent >= 0,
        ),
        'Invalid first exchange price change',
        ErrorCode.GameConfig,
    )
    const result = {
        resetHour,
        limit,
        increase,
        currency: currency.resourceID,
        items,
        events,
        currentRanges,
        first,
        firstChanges,
    }
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
    const eligible = exchangeEligibleEvents(tables, state)
    if (!eligible.length) {
        exchange.marketUnavailable = true
        exchange.marketChecked = exchangeMarketKey(tables, state, now)
        return exchange
    }
    delete exchange.marketUnavailable
    if (
        exchange.market?.day !== clock.businessDay ||
        !eligible.some((row) => row.EventId === exchange.market.eventId) ||
        (config.currentRanges && exchange.marketSourceVersion !== exchangePolicy.resourceVersion)
    ) {
        const pick = (rows) => rows[rng(0, rows.length)]
        const old = exchange.market
        if (
            old &&
            (!config.events.some((row) => row.EventId === old.eventId) ||
                (config.currentRanges && exchange.marketSourceVersion !== exchangePolicy.resourceVersion))
        )
            exchange.legacyMarket ??= structuredClone(old)
        const event =
            (old?.day === clock.businessDay - 1 && eligible.find((row) => row.EventId === old.nextEventId)) ||
            pick(eligible)
        const next = pick(eligible.length > 1 ? eligible.filter((row) => row !== event) : eligible)
        const tags = list(event.PriceIncreaseTag),
            changes = {}
        for (const row of config.items.values())
            if (list(row.Tag).some((tag) => tags.includes(tag)))
                changes[row.id] = rng(config.increase[0], config.increase[1] + 1)
        if (config.currentRanges && event.EventId === config.first[2]) {
            for (const id of Object.keys(changes)) delete changes[id]
            for (const [id, upper, percent] of config.firstChanges) changes[id] = upper ? percent : -percent
        }
        exchange.market = { day: clock.businessDay, eventId: event.EventId, nextEventId: next.EventId, tags, changes }
        exchange.marketSourceVersion = exchangePolicy.resourceVersion
    }
    exchange.marketChecked = exchangeMarketKey(tables, state, now)
    return exchange
}
function exchangeEligibleEvents(tables, state) {
    const config = exchangeCatalogue(tables)
    const firstActive =
        config.first.length &&
        (state.tasks ?? []).some((task) => task.task_id === config.first[0]) &&
        !(state.taskRecords ?? []).some((task) => task.task_id === config.first[0] && task.count > 0)
    return config.events.filter(
        (row) =>
            exchangeEventUnlocked(tables, state, row) &&
            (!config.currentRanges ||
                (firstActive ? row.EventId === config.first[2] : row.EventId !== config.first[2])),
    )
}
function exchangeMarketKey(tables, state, now) {
    const first = exchangeCatalogue(tables).first[0]
    const active =
        (state.tasks ?? []).some((task) => task.task_id === first) &&
        !(state.taskRecords ?? []).some((task) => task.task_id === first && task.count > 0)
    return `${exchangeClock(tables, now).businessDay}:${exchangePolicy.eventUnlock}:${state.home?.level ?? 1}:${state.player.basic_info.lv}:${active}`
}
export function exchangeEventUnlocked(tables, state, row) {
    if (!exchangeCatalogue(tables).currentRanges) return homeCondition(row.EventUnlock, state)
    ensure(
        ['home-level-inclusive-range', 'player-level-inclusive-range'].includes(exchangePolicy.eventUnlock),
        'Unsupported exchange event policy',
        ErrorCode.GameConfig,
    )
    const bounds = list(row.EventUnlock)
    ensure(
        bounds.length === 2 && bounds.every((n) => Number.isInteger(n) && n > 0) && bounds[0] <= bounds[1],
        'Invalid exchange event level bounds',
        ErrorCode.GameConfig,
    )
    const level =
        exchangePolicy.eventUnlock === 'home-level-inclusive-range'
            ? (state.home?.level ?? 1)
            : state.player.basic_info.lv
    ensure(Number.isSafeInteger(level) && level > 0, 'Invalid home level for exchange event', ErrorCode.GameConfig)
    return level >= bounds[0] && level <= bounds[1]
}
export function exchangeWeeklyIncome(tables, state, now) {
    const { weekStart } = exchangeClock(tables, now)
    return exchangeIncomeForWeek(state, weekStart)
}
function exchangeIncomeForWeek(state, weekStart) {
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
    ensure(
        state.homeExchange?.market && !state.homeExchange.marketUnavailable,
        'Exchange market is not open',
        ErrorCode.FunctionClosed,
    )
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
    const quantities = new Map()
    for (const row of state.homeExchange?.box ?? []) quantities.set(row.id, (quantities.get(row.id) ?? 0) + row.num)
    return {
        obj_info: [...quantities].map(([id, num]) => ({ id, num })),
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
