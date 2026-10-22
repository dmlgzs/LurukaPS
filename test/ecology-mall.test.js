import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { MallCatalog } from '../src/mall.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
function fixture() {
    let now = 1800000000,
        draws = 0
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, {
            clock: () => now,
            rng: (n) => {
                draws++
                return n - 1
            },
        }),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: 9876, pushSeq: 0, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'ecology-mall' })
    return {
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        setTime: (n) => {
            now = n
        },
        draws: () => draws,
    }
}
test('periodic ecology refresh is a stable map snapshot, not a combat reset or reroll', () => {
    const f = fixture()
    try {
        const first = f.call('WorldEcologyReset')
        assert.equal(first[0].id, 9190)
        assert.equal(first.at(-1).id, 9193)
        assert.deepEqual(first[0].data.event_data, [])
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 996
            s.combat = { sentinel: 42 }
        })
        const active = f.call('WorldEcologyReset')[0].data.event_data
        assert.equal(active.length, 5)
        assert(active.every((x) => x.status === 0 && tables.find('world_eep_template', x.template_id)))
        const draws = f.draws()
        f.setTime(1800000020)
        assert.deepEqual(f.call('WorldEcologyReset')[0].data.event_data, active)
        assert.equal(f.draws(), draws)
        assert.deepEqual(f.state().combat, { sentinel: 42 })
        f.store.transact(f.session.id, 0, (s) => {
            s.ecology.events[active[0].id].step = 1
            s.ecology.events[active[0].id].status = 1
        })
        assert.equal(f.call('WorldEcologyReset')[0].data.event_data[0].step, 1)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101
        })
        const away = f.call('WorldEcologyReset')[0].data
        assert.deepEqual(
            away.del_event,
            active.map((x) => x.id),
        )
        assert.deepEqual(away.event_data, [])
        assert.equal(Object.keys(f.state().ecology.events).length, 5)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 996
        })
        assert.equal(f.call('WorldEcologyReset')[0].data.event_data[0].status, 1)
        assert.equal(f.draws(), draws)
    } finally {
        f.store.close()
    }
})
test('mall list queries join the actual goods catalog and expose level locks', () => {
    const f = fixture()
    try {
        const pay = f.call('PlayerMallGetPayGoodsList', { pay_shop_id: 201 })[0].data
        assert.deepEqual(
            pay.pay_goods_list.map((x) => x.goods_id),
            [20101, 20102, 20103],
        )
        assert(pay.pay_goods_list.every((x) => x.is_pay_goods))
        const diamond = f.call('PlayerMallGetDiamondGoodsList', { diamond_shop_id: 201 })[0].data
        assert.equal(diamond.diamond_goods_list.length, 18)
        const levelGift = diamond.diamond_goods_list.find((x) => x.goods_id === 20501)
        assert.equal(levelGift.is_all_cond_done, false)
        assert.deepEqual(levelGift.unlock_cond_id, [2004])
        assert.deepEqual(levelGift.unlock_progress, [1])
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 10
        })
        assert.equal(
            f
                .call('PlayerMallGetDiamondGoodsList', { diamond_shop_id: 201 })
                .find((p) => p.id === protocol.byName.get('CSProtoPlayerMallGetDiamondGoodsList').id)
                .data.diamond_goods_list.find((x) => x.goods_id === 20501).is_all_cond_done,
            true,
        )
        assert.equal(f.call('PlayerMallGetPayGoodsList', { pay_goods_id: 20101 })[0].data.pay_goods_list.length, 1)
        assert.throws(() => f.call('PlayerMallGetPayGoodsList', { pay_shop_id: 203, pay_goods_id: 20101 }))
    } finally {
        f.store.close()
    }
})
test('mall refresh counters follow periods and recharge queries do not manufacture purchases', () => {
    const f = fixture()
    try {
        const catalog = new MallCatalog(tables),
            now = 1800000000,
            daily = catalog.goods(false, 20301, f.state(), now)
        assert(Number(daily.reset_time) > now)
        assert.equal(daily.curr_purchase_num, 0)
        f.store.transact(f.session.id, 0, (s) => {
            s.mall = {
                purchases: { 'diamond:20301': { period: Number(daily.reset_time) - 86400, count: 1 } },
                recharges: [{ purchase_sdk_id: 2001, first_recharge_time: '9007199254740993' }],
            }
        })
        assert.equal(catalog.goods(false, 20301, f.state(), now).curr_purchase_num, 1)
        assert.equal(catalog.goods(false, 20301, f.state(), Number(daily.reset_time)).curr_purchase_num, 0)
        const recharge = f.call('PlayerMallGetRechargeDiamond')[0].data
        assert.deepEqual(recharge.purchase_sdk_id_list, [2001])
        assert.deepEqual(recharge.first_recharge_time_list, ['9007199254740993'])
        assert.equal(recharge.rewards, undefined)
        assert.equal(f.call('GetRechargePopupData')[0].data.popup_id, 0)
    } finally {
        f.store.close()
    }
})
test('mall red-dot updates merge persistently, synchronize before reply and reject unknown goods atomically', () => {
    const f = fixture()
    try {
        const packets = f.call('MallReddotSet', { pay_reddot: [{ goods_id: 20101, status: 1 }] })
        assert.equal(packets[0].id, 18045)
        assert.equal(packets.at(-1).id, 18046)
        f.call('MallReddotSet', { diamond_reddot: [{ goods_id: 20301, status: 0 }] })
        assert.equal(f.state().mall.reddots.pay_reddot[0].goods_id, 20101)
        const before = f.store.load(f.session.id)
        assert.throws(() =>
            f.call('MallReddotSet', {
                diamond_reddot: [{ goods_id: 20301, status: 1 }],
                pay_reddot: [{ goods_id: 999999, status: 0 }],
            }),
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})
