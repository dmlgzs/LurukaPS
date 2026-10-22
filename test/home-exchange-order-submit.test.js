import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSyncBefore } from './exchange-sync-assertions.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { exchangeOrderPlan } from '../src/home-exchange-orders.js'
import { homeCondition } from '../src/home-grid.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture() {
    const p = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let seq = 1,
        now = 1792584000
    const game = new Game(p, store, tables, {
            clock: () => now,
            rng: (min) => min,
        }),
        call = (n, r = {}, who = session) => {
            const e = p.byName.get('CSProto' + n)
            return game.dispatch(who, { id: e.id, seq: seq++, payload: p.encode(e.req, r) }).map((x) => ({
                id: x.id,
                data: p.decode(p.byId.get(x.id).rsp, x.payload),
            }))
        },
        state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'exchange-order-submit' })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 45
        s.player.sbag_infos.items = []
    })
    call('CSExchangeOrderBoard')
    const fund = (row) =>
        store.transact(session.id, 0, (s) => grantRewards(tables, s, parseRewards(row.orderNeedMaterials)))
    return {
        p,
        store,
        session,
        game,
        call,
        state,
        fund,
        now: () => now,
        setNow: (n) => {
            now = n
        },
    }
}
const amount = (s, id) => Number(s.player.attr_infos.attrs.find((r) => r.attr_id === id)?.attr_val ?? 0)
const bag = (s, id) => s.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((n, r) => n + r.itemnum, 0)
test('6227 pays the actual configured currency and reputation before ACK, consumes materials once, and removes only the completed slot', () => {
    const f = fixture()
    try {
        const slot = f.state().homeExchange.board.slots[0],
            row = tables.get('home_exchange_order').find((r) => r.orderID === slot.order_id)
        f.fund(row)
        const before = f.state(),
            reward = parseRewards(row.orderReward)[0],
            rep = parseRewards(row.orderReputation)[0]
        const result = f.call('CSFinishOrder', { order_guid: slot.guid }),
            response = result.find((p) => p.id === 6227).data
        assert.equal(amount(f.state(), reward.itemid) - amount(before, reward.itemid), reward.itemnum)
        for (const cost of parseRewards(row.orderNeedMaterials))
            assert.equal(bag(before, cost.itemid) - bag(f.state(), cost.itemid), cost.itemnum)
        assert.equal(f.state().reputations[rep.itemid].value, rep.itemnum)
        assert.equal(f.state().player.basic_info.exp, before.player.basic_info.exp)
        assert.equal(response.base.order_guid.length, 5)
        assert(!response.base.order_guid.some((s) => s.guid === slot.guid))
        assert.equal(response.rewards[0].src, 146)
        assert(
            response.rewards[0].rewards.some(
                (r) => r.itemtype === 29 && r.itemid === tables.find('groups', rep.itemid).reputation,
            ),
        )
        const reputationSynchronization = assertSyncBefore(f.p, result, 'CSProtoReputationInfo', 6227)
        assert(
            reputationSynchronization
                .flatMap((packet) => packet.data.infos ?? [])
                .some((info) => info.rep_id === rep.itemid && info.value === rep.itemnum),
        )
        const synchronization = assertSyncBefore(f.p, result, 'CSProtoSyncPlayerData', 6227)
        assert(
            synchronization
                .flatMap((packet) => packet.data.attr_infos?.attrs ?? [])
                .some(
                    (item) =>
                        item.attr_id === reward.itemid &&
                        String(item.attr_val) === String(amount(f.state(), reward.itemid)),
                ),
            'the actual reward currency must already be synchronized',
        )
        const after = f.state()
        assert.deepEqual(f.call('CSFinishOrder', { order_guid: slot.guid }).find((p) => p.id === 6227).data.rewards, [])
        assert.deepEqual(f.state().player, after.player)
        assert.deepEqual(f.state().reputations, after.reputations)
        assert.equal(f.state().homeExchange.completedOrders, 1)
        f.call('EnterGame', { open_id: 'exchange-order-submit' }, {})
        assert.equal(f.state().reputations[rep.itemid].value, rep.itemnum)
        assert.equal(f.call('CSExchangeOrderBoard').find((p) => p.id === 6225).data.base.order_guid.length, 5)
    } finally {
        f.store.close()
    }
})
test('all672 current orders have payable material and reputation plans, and monthly benefit follows its exact resource and rate', () => {
    const state = { player: { basic_info: { lv: 45 } } },
        rows = tables.get('home_exchange_order')
    assert.equal(rows.length, 672)
    for (const row of rows) {
        const plan = exchangeOrderPlan(tables, state, row, 1792584000)
        assert(plan.costs.every((c) => c.itemtype === 3 && c.itemnum > 0 && tables.find('common_item', c.itemid)))
        assert(plan.rewards.some((r) => r.itemtype === 10 && r.itemid === 103))
        assert(plan.rewards.some((r) => r.itemtype === 29 && tables.find('groups', r.itemid)))
    }
    const f = fixture()
    try {
        const row = rows.toSorted(
            (a, b) => parseRewards(b.orderReward)[0].itemnum - parseRewards(a.orderReward)[0].itemnum,
        )[0]
        f.store.transact(f.session.id, 0, (s) => {
            const slot = s.homeExchange.board.slots.find((s) => s.level === row.orderLevel)
            slot.order_id = row.orderID
            s.monthlyCard = {
                config_id: 1,
                purchase_sdk_id: 5001,
                end_time: f.now() + 86400,
                claim_until: 0,
            }
        })
        f.fund(row)
        const slot = f.state().homeExchange.board.slots.find((s) => s.order_id === row.orderID),
            before = amount(f.state(), 103)
        const result = f.call('CSFinishOrder', { order_guid: slot.guid }),
            base = parseRewards(row.orderReward)[0].itemnum
        assert.equal(amount(f.state(), 103) - before, base + Math.floor((base * 500) / 10000))
        assert(base > 22500, 'the legacy order cap is not a current transaction limit')
        assert.equal(
            result.find((p) => p.id === 6227).data.rewards[0].rewards.find((r) => r.itemid === 103).itemnum,
            base + Math.floor(base * 0.05),
        )
    } finally {
        f.store.close()
    }
})
test('order failure rolls back materials, currency, reputation, completion and response receipts', () => {
    const f = fixture()
    try {
        const slot = f.state().homeExchange.board.slots[0],
            row = tables.get('home_exchange_order').find((r) => r.orderID === slot.order_id),
            empty = f.state()
        assert.throws(
            () => f.call('CSFinishOrder', { order_guid: slot.guid }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), empty)
        f.fund(row)
        const before = f.state(),
            encode = f.p.encode
        f.p.encode = function (n, r) {
            if (n === f.p.byId.get(6227).rsp) throw Error('injected submit response')
            return encode.call(this, n, r)
        }
        assert.throws(() => f.call('CSFinishOrder', { order_guid: slot.guid }), /injected submit/)
        assert.deepEqual(f.state(), before)
        f.p.encode = encode
        f.call('CSFinishOrder', { order_guid: slot.guid })
        assert.equal(f.state().homeExchange.completedOrders, 1)
    } finally {
        f.store.close()
    }
})
test('reputation progresses through the actual level curve, unlocks61001 recipes and never mutates a borrowed combat base record', () => {
    const f = fixture()
    try {
        const base = f.state(),
            draft = { ...base },
            before = structuredClone(base.reputations)
        grantRewards(tables, draft, [{ itemtype: 29, itemid: 10, itemnum: 420 }])
        assert.equal(draft.reputations[10].level, 3)
        assert.equal(draft.reputations[10].value, 0)
        assert(homeCondition('61001#10#3', draft))
        assert(!homeCondition('61001#10#4', draft))
        assert.deepEqual(base.reputations, before)
        grantRewards(tables, draft, [{ itemtype: 29, itemid: 10, itemnum: 380 }])
        assert.equal(draft.reputations[10].level, 4)
        assert.equal(draft.reputations[10].overflow, 20)
        assert.equal(draft.reputations[10].total, 800)
    } finally {
        f.store.close()
    }
})

test('current monthly order benefit reads mall_game rather than the retained game duplicate', () => {
    const row = tables.get('home_exchange_order')[0],
        state = {
            player: { basic_info: { lv: 45 } },
            monthlyCard: { end_time: 1800000100, purchase_sdk_id: 5001 },
        }
    const fake = Object.create(tables)
    fake.get = (name) =>
        name === 'game'
            ? tables.get(name).map((r) => (r.title === 'MONTHLY_CADR_HOME_BUFF_VALUE' ? { ...r, value: '5000' } : r))
            : tables.get(name)
    const base = parseRewards(row.orderReward)[0].itemnum
    assert.equal(
        exchangeOrderPlan(fake, state, row, 1800000000).rewards.find((r) => r.itemtype === 10 && r.itemid === 103)
            .itemnum,
        base + Math.floor(base * 0.05),
    )
    const other = Object.create(fake)
    other.get = (name) =>
        name === 'mall_game'
            ? tables.get(name).map((r) => (r.title === 'MONTHLY_CADR_HOME_BUFF_VALUE' ? { ...r, value: '1000' } : r))
            : fake.get(name)
    assert.equal(
        exchangeOrderPlan(other, state, row, 1800000000).rewards.find((r) => r.itemtype === 10 && r.itemid === 103)
            .itemnum,
        base + Math.floor(base * 0.1),
    )
})
