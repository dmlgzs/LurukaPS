import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import {
    ensureHomeExchange,
    exchangeCatalogue,
    exchangeClock,
    exchangeUnitPrice,
    prepareHomeExchange,
    homeExchangeDue,
    returnExchangeReservation,
} from '../src/home-exchange.js'
import { exchangeOrderWindow, exchangeOrderUnlocked, orderCandidates } from '../src/home-exchange-orders.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const clock = 1795629881
function fixture() {
    const store = new Store(':memory:'),
        session = {},
        time = { now: clock }
    const game = new Game(protocol, store, tables, { clock: () => time.now, rng: (min) => min })
    let seq = 1
    const call = (name, request = {}, target = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(target, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
            })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    call('EnterGame', { open_id: 'obt-exchange' })
    store.transact(session.id, 0, (state) => {
        state.home.level = 6
        state.player.basic_info.lv = 36
    })
    assert(game.tick(session.id, session).some((packet) => packet.id === 6219))
    return { store, session, game, time, call, state: () => store.load(session.id).state }
}

test('current event bounds use the declared local home-level policy without modifying level or force-opening closed markets', () => {
    const state = {
        home: { level: 1 },
        player: { basic_info: { lv: 36 } },
        tasks: [],
        taskRecords: [],
        homeExchange: {
            history: [],
            box: [],
            market: { day: 1, eventId: 20025, nextEventId: 20024, tags: [25], changes: { 1: 69 } },
        },
    }
    const old = structuredClone(state.homeExchange.market)
    assert.doesNotThrow(() => ensureHomeExchange(tables, state, clock, (min) => min))
    assert.equal(state.homeExchange.marketUnavailable, true)
    assert.deepEqual(state.homeExchange.market, old)
    assert.equal(state.home.level, 1)
    assert.equal(homeExchangeDue(tables, state, clock), false)
    state.home.level = 5
    assert.equal(homeExchangeDue(tables, state, clock), true)
    ensureHomeExchange(tables, state, clock, (min) => min)
    assert.equal(state.homeExchange.marketUnavailable, undefined)
    assert.equal(state.homeExchange.market.eventId, 20001)
    assert.deepEqual(state.homeExchange.legacyMarket, old)
    assert.equal(state.home.level, 5)
    assert.deepEqual(state.taskRecords, [])
})

test('current fixed quotes use ceil and current external prices, while the configured first event is tied to its active task', () => {
    const state = { home: { level: 6 }, player: { basic_info: { lv: 36 } }, tasks: [], taskRecords: [] }
    ensureHomeExchange(tables, state, clock, (min) => min)
    state.homeExchange.market.changes[10310342] = 35
    assert.equal(tables.find('home_exchange_item', 10310342).price, 215)
    assert.equal(exchangeUnitPrice(tables, state, 10310342), 291)
    assert.equal(Object.hasOwn(tables.find('home_exchange_item', 10310342), 'bonusRate'), false)
    state.tasks = [{ task_id: 402001 }]
    ensureHomeExchange(tables, state, clock, (min) => min)
    assert.equal(state.homeExchange.market.eventId, 10001)
    assert.deepEqual(state.homeExchange.market.changes, { 10330011: 66, 10330031: 66, 10330021: 66 })
    assert.equal(exchangeCatalogue(tables).events.length, 7)
})

test('current order bands are closed intervals and all seven one-day schedules offer 2/1/1 slots', () => {
    for (let weekday = 0; weekday < 7; weekday++) {
        const window = exchangeOrderWindow(tables, clock + weekday * 86400)
        assert.equal(window.end - window.start, 86400)
        assert.deepEqual(
            window.tiers.map((tier) => [tier.orderLevel, tier.orderNum]),
            [
                [1, 2],
                [2, 1],
                [3, 1],
            ],
        )
    }
    for (const [level, band] of [
        [9, null],
        [10, '2004#10|2004#19'],
        [19, '2004#10|2004#19'],
        [20, '2004#20|2004#29'],
        [29, '2004#20|2004#29'],
        [30, '2004#30|2004#44'],
        [44, '2004#30|2004#44'],
        [45, '2004#45|2004#999'],
    ]) {
        const state = { player: { basic_info: { lv: level } } }
        const candidates = orderCandidates(tables, state, 1)
        assert(
            band
                ? candidates.length > 0 && candidates.every((row) => row.orderUnlock === band)
                : candidates.length === 0,
        )
        if (band) assert(exchangeOrderUnlocked(band, state))
    }
})

test('legacy quoted shipments settle and cancel from their saved item proof without repricing through repurposed exchange IDs', () => {
    const f = fixture()
    try {
        const state = f.state()
        const entry = {
            id: 10310011,
            num: 3,
            unitPrice: 17,
            day: exchangeClock(tables, clock).businessDay - 1,
            shippingAt: clock - 100,
            settleAt: clock - 1,
            items: [{ guid: '900000', itemid: 400101, itemtype: 3, itemnum: 3 }],
        }
        assert.notEqual(tables.find('home_exchange_item', entry.id).itemId, entry.items[0].itemid)
        state.home.level = 1
        state.homeExchange = { history: [], box: [entry], shipments: [] }
        const wallet = () => BigInt(state.player.attr_infos.attrs.find((attr) => attr.attr_id === 103)?.attr_val ?? '0')
        const before = wallet()
        prepareHomeExchange({ tables, state, now: clock, randomInt: (min) => min }, { publish: false })
        assert.equal(wallet() - before, 53n)
        assert.equal(state.homeExchange.history[0].profit, 51)
        assert.equal(state.homeExchange.history[0].extra_num, 2)
        assert.equal(state.homeExchange.shipments.length, 0)
        assert.equal(state.homeExchange.marketUnavailable, true)
        prepareHomeExchange({ tables, state, now: clock, randomInt: (min) => min }, { publish: false })
        assert.equal(wallet() - before, 53n)
        state.homeExchange.box = [{ ...entry, shippingAt: clock + 1000, settleAt: clock + 2000 }]
        returnExchangeReservation({ tables, state, now: clock }, { id: entry.id })
        assert.equal(state.player.sbag_infos.items.find((item) => item.guid === '900000').itemid, 400101)
        assert.equal(state.homeExchange.box.length, 0)
    } finally {
        f.store.close()
    }
})

test('legacy market and six-slot board migrate to current definitions without losing history or reusing old live order identities', () => {
    const f = fixture()
    try {
        const legacyMarket = { day: 1, eventId: 20025, nextEventId: 20024, tags: [25], changes: { 10310011: 69 } }
        const legacyBoard = {
            start: 1,
            end: 2,
            refreshes: 1,
            slots: [1, 2, 3, 4, 5, 6].map((guid) => ({ guid, level: 1, order_id: 900000 + guid })),
        }
        const history = [{ history_time: clock - 86400, profit: 1400, settle_num: 100, extra_num: 0 }]
        f.store.transact(f.session.id, 0, (state) => {
            state.homeExchange = {
                market: structuredClone(legacyMarket),
                board: structuredClone(legacyBoard),
                history: structuredClone(history),
                box: [],
            }
        })
        const entered = f.call('EnterGame', { open_id: 'obt-exchange', reconnect: true }, {})
        assert(entered.some((packet) => packet.id === 5001))
        assert.deepEqual(f.state().homeExchange.legacyMarket, legacyMarket)
        assert.deepEqual(f.state().homeExchange.history, history)
        const board = f.call('CSExchangeOrderBoard').find((packet) => packet.id === 6225).data.base
        assert.equal(board.order_guid.length, 4)
        assert(board.order_guid.every((order) => order.guid > 6))
        assert.equal(board.end_time - board.start_time, 86400)
        assert.deepEqual(f.state().homeExchange.legacyBoard, legacyBoard)
        assert.throws(
            () => f.call('CSFinishOrder', { order_guid: 1 }),
            (error) => error.code === ErrorCode.HomeOrderNotExists,
        )
        const selected = board.order_guid[0],
            row = tables.get('home_exchange_order').find((row) => row.orderID === selected.order_id)
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.lv = 45
            grantRewards(tables, state, parseRewards(row.orderNeedMaterials))
        })
        assert.deepEqual(
            f.call('CSExchangeOrderBoard').find((packet) => packet.id === 6225).data.base.order_guid,
            board.order_guid,
        )
        const settled = f.call('CSFinishOrder', { order_guid: selected.guid })
        assert(settled.find((packet) => packet.id === 6227).data.rewards.length)
        assert.equal(f.state().homeExchange.orderReceipts[selected.guid].id, row.orderID)
    } finally {
        f.store.close()
    }
})

test('current deposit cancel immediate sale and midnight shipment complete with actual quotes and no duplicate settlement', () => {
    const f = fixture()
    try {
        assert(f.state().homeExchange.market)
        f.store.transact(f.session.id, 0, (state) =>
            grantRewards(tables, state, [{ itemtype: 3, itemid: 400101, itemnum: 300 }]),
        )
        const wallet = () =>
            BigInt(f.state().player.attr_infos.attrs.find((attr) => attr.attr_id === 103)?.attr_val ?? '0')
        const quantity = (id) =>
            f
                .state()
                .player.sbag_infos.items.filter((item) => item.itemid === id)
                .reduce((sum, item) => sum + item.itemnum, 0)
        const price = exchangeUnitPrice(tables, f.state(), 10360011),
            before = wallet(),
            stock = quantity(400101)
        f.call('CSAddExchangeObj', { id: 10360011, num: 10, type: 3 })
        assert.equal(f.state().homeExchange.box[0].unitPrice, price)
        assert.equal(quantity(400101), stock - 10)
        f.call('CSCancelExangeObj', { id: 10360011 })
        assert.equal(quantity(400101), stock)
        f.call('CSAddExchangeObj', { id: 10360011, num: 20, type: 3 })
        const immediate = f.call('CSSettleImmediately').find((packet) => packet.id === 6224).data
        assert.equal(immediate.award.rewards.find((reward) => reward.itemid === 103).itemnum, price * 20)
        assert.equal(wallet() - before, BigInt(price * 20))
        assert.deepEqual(f.call('CSSettleImmediately').find((packet) => packet.id === 6224).data.award.rewards, [])
        f.call('CSAddExchangeObj', { id: 10360011, num: 71, type: 3 })
        const booked = f.state().homeExchange.box[0]
        f.time.now = booked.shippingAt + 1
        f.game.tick(f.session.id, f.session)
        assert.equal(f.state().homeExchange.box.length, 0)
        assert.equal(f.state().homeExchange.shipments.length, 1)
        assert.equal(wallet() - before, BigInt(price * 20))
        f.time.now = booked.settleAt
        const crate = quantity(1520101)
        f.game.tick(f.session.id, f.session)
        const scheduled = price * 71 + Math.floor((price * 71 * 500) / 10000)
        assert.equal(wallet() - before, BigInt(price * 20 + scheduled))
        assert.equal(quantity(1520101), crate + 1)
        assert.equal(f.state().homeExchange.shipments.length, 0)
        f.game.tick(f.session.id, f.session)
        f.call('CSHistoryReport')
        assert.equal(wallet() - before, BigInt(price * 20 + scheduled))
        assert.equal(quantity(1520101), crate + 1)
    } finally {
        f.store.close()
    }
})
