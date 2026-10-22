import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { exchangeClock, exchangeWeeklyIncome } from '../src/home-exchange.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture() {
    const p = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let now = 1792584000,
        seq = 1
    const game = new Game(p, store, tables, { clock: () => now, rng: (min) => min })
    const decode = (packets) => packets.map((x) => ({ id: x.id, data: p.decode(p.byId.get(x.id).rsp, x.payload) }))
    const call = (n, r = {}, who = session) => {
        const e = p.byName.get('CSProto' + n)
        return decode(game.dispatch(who, { id: e.id, seq: seq++, payload: p.encode(e.req, r) }))
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'exchange-settlement' })
    store.transact(session.id, 0, (s) => {
        s.player.sbag_infos.items = []
        grantRewards(tables, s, [{ itemtype: 3, itemid: 400101, itemnum: 300 }])
        const a = s.player.attr_infos.attrs.find((a) => a.attr_id === 103)
        if (a) a.attr_val = '0'
        else s.player.attr_infos.attrs.push({ attr_id: 103, attr_val: '0' })
    })
    const deposit = (num) => call('CSAddExchangeObj', { id: 10360011, num, type: 3 })
    return {
        p,
        store,
        game,
        session,
        call,
        state,
        deposit,
        setNow: (n) => {
            now = n
        },
        now: () => now,
        tick: () => decode(game.tick(session.id)),
    }
}
const wallet = (s) => Number(s.player.attr_infos.attrs.find((a) => a.attr_id === 103)?.attr_val ?? 0)
const items = (s, id) => s.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)
test('6224 settles the quoted principal into actual home currency, gives no delayed bonus, and cannot duplicate payout', () => {
    const f = fixture()
    try {
        f.deposit(71)
        const gold = f.state().player.basic_info.gold
        const result = f.call('CSSettleImmediately'),
            award = result.find((p) => p.id === 6224).data.award
        assert.deepEqual(
            award.rewards.map((r) => [r.itemtype, r.itemid, r.itemnum]),
            [[10, 103, 142]],
        )
        assert.equal(award.src, 144)
        assert.equal(wallet(f.state()), 142)
        assert.equal(f.state().player.basic_info.gold, gold)
        assert.equal(items(f.state(), 1520101), 0)
        assert.deepEqual(f.state().homeExchange.box, [])
        assert.equal(f.state().homeExchange.history[0].profit, 142)
        assert.equal(f.state().homeExchange.history[0].settle_num, 71)
        assert.equal(f.state().homeExchange.history[0].extra_num, 0)
        assert(result.findIndex((p) => p.id === 6023) < result.findIndex((p) => p.id === 6224))
        assert.deepEqual(f.call('CSSettleImmediately').find((p) => p.id === 6224).data.award.rewards, [])
        assert.equal(wallet(f.state()), 142)
        assert.equal(exchangeWeeklyIncome(tables, f.state(), f.now()), 142)
    } finally {
        f.store.close()
    }
})
test('scheduled merchant return pays the configured tier once at 04:00, keeps goods in transit before then, and sends the real inventory before its notice', () => {
    const f = fixture()
    try {
        f.deposit(71)
        const { shippingAt, settleAt } = exchangeClock(tables, f.now())
        const beforeRevision = f.store.playerById.get(f.session.id).revision
        assert.deepEqual(f.tick(), [])
        assert.equal(f.store.playerById.get(f.session.id).revision, beforeRevision)
        f.setNow(shippingAt + 1)
        assert(f.tick().some((p) => p.id === 6229 && p.data.obj_info.length === 0))
        assert.equal(wallet(f.state()), 0)
        assert.throws(() => f.call('CSCancelExangeObj', { id: 10360011 }), /not found/)
        assert.deepEqual(f.state().homeExchange.box, [])
        assert.equal(f.state().homeExchange.shipments.length, 1)
        f.setNow(settleAt - 1)
        assert.equal(
            f.tick().some((p) => p.id === 6228),
            false,
        )
        assert.equal(wallet(f.state()), 0)
        f.setNow(settleAt)
        const result = f.tick(),
            notice = result.find((p) => p.id === 6228).data.history.extra_info.award
        assert.equal(wallet(f.state()), 149)
        assert.equal(items(f.state(), 1520101), 1)
        assert(result.findIndex((p) => p.id === 6023) < result.findIndex((p) => p.id === 6228))
        assert.equal(notice.rewards.find((r) => r.itemid === 103).itemnum, 149)
        assert.equal(f.state().homeExchange.history[0].extra_num, 7)
        assert.deepEqual(f.tick(), [])
        assert.deepEqual(f.call('CSHistoryReport').find((p) => p.id === 6220).data.extra_info.award.rewards, [])
        assert.equal(wallet(f.state()), 149)
    } finally {
        f.store.close()
    }
})
test('offline login settles the old shipment with its saved quote and preserves financial and award receipts across repeat logins', () => {
    const f = fixture()
    try {
        f.deposit(71)
        const quote = f.state().homeExchange.box[0].unitPrice
        f.setNow(exchangeClock(tables, f.now()).settleAt + 4 * 86400)
        const login = f.call('EnterGame', { open_id: 'exchange-settlement' }, {})
        assert.equal(wallet(f.state()), Math.floor(71 * quote * 1.05))
        assert.equal(items(f.state(), 1520101), 1)
        assert(login.some((p) => p.id === 6228 && p.data.history.extra_info.award.rewards.length === 2))
        const total = wallet(f.state())
        const repeated = f.call('EnterGame', { open_id: 'exchange-settlement' }, {})
        assert(repeated.some((p) => p.id === 6228 && p.data.history.extra_info.award.rewards.length === 0))
        assert.equal(wallet(f.state()), total)
    } finally {
        f.store.close()
    }
})
test('settlement response failures roll back wallet, escrow, report and notices; later table tiers use their actual zero bonuses', () => {
    const f = fixture()
    try {
        f.deposit(100)
        const before = f.state(),
            encode = f.p.encode
        f.p.encode = function (n, r) {
            if (n === f.p.byId.get(6224).rsp) throw Error('injected settlement encoding')
            return encode.call(this, n, r)
        }
        assert.throws(() => f.call('CSSettleImmediately'), /injected settlement/)
        assert.deepEqual(f.state(), before)
        f.p.encode = encode
        f.setNow(exchangeClock(tables, f.now()).settleAt)
        f.tick()
        const tier = tables.get('home_exchange_sell_extrareward').find((r) => r.SellNum === 100)
        assert.equal(tier.YieldIncreases, 0)
        assert.equal(tier.ItemReward, '')
        assert.equal(wallet(f.state()), 200)
        assert.equal(items(f.state(), 1520101), 0)
    } finally {
        f.store.close()
    }
})

test('the observed 02:03 booking is accepted for the next departure while the previous shipment returns independently', () => {
    const f = fixture()
    try {
        f.deposit(10)
        const { shippingAt, settleAt } = exchangeClock(tables, f.now())
        f.setNow(shippingAt + 2 * 3600 + 3 * 60)
        f.deposit(71)
        assert.equal(f.state().homeExchange.shipments[0].items[0].num, 10)
        assert.equal(f.state().homeExchange.box[0].num, 71)
        assert.equal(f.state().homeExchange.box[0].settleAt, settleAt + 86400)
        f.call('CSCancelExangeObj', { id: 10360011 })
        f.deposit(71)
        f.setNow(settleAt)
        f.tick()
        assert.equal(wallet(f.state()), 21)
        assert.equal(f.state().homeExchange.box[0].num, 71)
        assert.deepEqual(f.state().homeExchange.shipments, [])
        f.call('CSCancelExangeObj', { id: 10360011 })
        assert.equal(items(f.state(), 400101), 290)
        assert.equal(wallet(f.state()), 21)
    } finally {
        f.store.close()
    }
})

test('overlapping quotes across the daily price change remain separate internally and cancel as one visible item', () => {
    const f = fixture()
    try {
        f.setNow(1792605600)
        f.call('CSExchangeObjInfo')
        const market = f.state().homeExchange.market
        const row = tables.get('home_exchange_item').find(
            (r) =>
                market.changes[r.id] &&
                r.price > 1 &&
                !String(r.Tag)
                    .split('|')
                    .some((t) => ['6', '7', '8', '10'].includes(t)),
        )
        assert(row)
        f.store.transact(f.session.id, 0, (s) => {
            grantRewards(tables, s, [{ itemtype: 3, itemid: row.itemId, itemnum: 10 }])
        })
        const before = items(f.state(), row.itemId)
        f.call('CSAddExchangeObj', { id: row.id, num: 1, type: 3 })
        f.setNow(exchangeClock(tables, f.now()).settleAt)
        const result = f.call('CSAddExchangeObj', { id: row.id, num: 1, type: 3 })
        const lots = f.state().homeExchange.box.filter((e) => e.id === row.id)
        assert.equal(lots.length, 2)
        assert.notEqual(lots[0].unitPrice, lots[1].unitPrice)
        assert.equal(
            result
                .filter((p) => p.id === 6229)
                .at(-1)
                .data.obj_info.find((e) => e.id === row.id).num,
            2,
        )
        f.call('CSCancelExangeObj', { id: row.id })
        assert.equal(items(f.state(), row.itemId), before)
    } finally {
        f.store.close()
    }
})
