import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { parseRewards } from '../src/rewards.js'
import { LOCAL_CALLBACK_NOTICE } from '../src/handlers/local-payments.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)

// Current MallParser06014093 / ShopStore0601c932,0601ca13,0601ca15.
// Records calls to the presentation layer; does not emulate Unity windows.
class MallConsumer {
    constructor(initialized = false) {
        this.initialized = initialized
        this.inventory = new ObtInventoryConsumer(tables, protocol)
        this.queries = []
        this.presentations = []
        this.web = []
        this.sdkAttempts = 0
        this.orderMasksClosed = 0
    }
    show(rewards) {
        if (!rewards?.rewards?.length) return
        for (const reward of rewards.rewards) {
            if (reward.itemtype === 3) assert(tables.find('common_item', reward.itemid))
            if (reward.itemtype === 9)
                assert(this.inventory.souls.has(String(reward.guid)), 'Reward presentation has no owned soul instance')
        }
        this.presentations.push({
            rewards: structuredClone(rewards.rewards),
            source: rewards.src ?? 0,
            paid: this.inventory.attributes.get(901) ?? 0n,
            bonus: this.inventory.attributes.get(902) ?? 0n,
        })
    }
    consume(packets) {
        for (const packet of packets) {
            if (packet.error) continue
            this.inventory.consumePackets([packet])
            const entry = protocol.byId.get(packet.id),
                data = protocol.decode(entry.rsp, packet.payload)
            if ([18035, 18038].includes(packet.id)) {
                // MallParser closes the request mask first. The current native
                // ShowErrorCodeTip ignores ClientCallBackErrorCode=-9999.
                this.orderMasksClosed++
                if (!(data.errcode ?? 0)) this.sdkAttempts++
                else assert.equal(data.errcode, LOCAL_CALLBACK_NOTICE)
            }
            if ([18036, 18039].includes(packet.id) && this.initialized) this.queries.push('GetRechargePopupData')
            if (packet.id === 18031) this.show(data.diamond_rewards)
            if (packet.id === 18033) this.show(data.pay_rewards)
            if (packet.id !== 18048) continue
            const rewards = [
                data.mall_data?.pay_rewards,
                data.non_mall_data?.is_oversold ? data.non_mall_data.oversold_rewards : undefined,
                data.recharge_diamond?.rewards,
            ]
            if (data.pay_source === 1) this.web.push(...rewards.filter(Boolean))
            else for (const reward of rewards) this.show(reward)
            if (
                data.mall_data ||
                data.non_mall_data ||
                data.battlepass_data ||
                data.recharge_diamond ||
                data.monthly_card_data
            )
                this.queries.push('GetRechargePopupData')
            else {
                for (const reward of this.web) this.show(reward)
                this.web = []
            }
        }
    }
}
function fixture(name, initialized = false) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, offlinePayments: true }),
        session = {},
        client = new MallConsumer(initialized)
    let seq = 1
    const call = (name, data = {}, consumer = client, target = session) => {
        const entry = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(target, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
            })
        consumer?.consume(packets)
        return packets
    }
    call('EnterGame', { open_id: 'mall-current-notification-' + name })
    return {
        store,
        client,
        call,
        edit: (fn) => store.transact(session.id, 0, fn),
        state: () => store.load(session.id).state,
        login: () => {
            const next = new MallConsumer()
            call('EnterGame', { open_id: 'mall-current-notification-' + name, reconnect: true }, next, {})
            return next
        },
    }
}
function drain(f) {
    let count = 0
    while (f.client.queries.length) {
        assert(count++ < 10, 'Popup receipt chain did not terminate')
        f.call(f.client.queries.shift())
    }
    return count
}

test('current cold ShopStore shows6480 from unsolicited18048 after wallet and delivery sync, without an initial mall query', () => {
    const f = fixture('cold-recharge')
    try {
        const row = tables.get('mall_recharge_diamond').find((row) => row.rechargeDiamondNum === 6480),
            request = {
                purchase_sdk_id: row.purchaseSdkID,
                buy_count: 1,
                product_id: 'lurukaps-offline:current-6480:local',
                amount: '0',
            },
            paid = f.client.inventory.attributes.get(901) ?? 0n,
            bonus = f.client.inventory.attributes.get(902) ?? 0n,
            packets = f.call('NonMallCreatePayOrder', request),
            popup = packets.find((packet) => packet.id === 18048),
            view = f.client.presentations[0]
        assert.equal(f.client.presentations.length, 1)
        assert.equal(popup.seq ?? 0, 0)
        assert(packets.findIndex((packet) => packet.id === 18039) < packets.indexOf(popup))
        assert(packets.findIndex((packet) => packet.id === 18043) < packets.indexOf(popup))
        assert.equal(view.paid, paid + BigInt(row.rechargeDiamondNum))
        assert.equal(view.bonus, bonus + BigInt(row.firstRechargeBonus))
        assert.equal(view.source, 0, 'An omitted optional reward src does not block CommonShowRewards')
        assert.equal(f.client.sdkAttempts, 0)
        assert.equal(f.client.orderMasksClosed, 1)
        assert.equal(drain(f), 1)
        assert.equal(f.state().mall.popupQueue.length, 0)
        f.call('NonMallCreatePayOrder', request)
        assert.equal(f.client.presentations.length, 1)
        const logged = f.login()
        f.call('GetRechargePopupData', {}, logged)
        assert.equal(logged.presentations.length, 0)
        const missingPush = new MallConsumer()
        missingPush.consume(packets.filter((packet) => packet.id !== 18048))
        assert.equal(missingPush.presentations.length, 0)
        assert.equal(missingPush.queries.length, 0, 'A cold success notification alone does not pull18048')
    } finally {
        f.store.close()
    }
})

test('current initialized ShopStore gift success and unsolicited receipt may both request the next popup without double presentation', () => {
    const f = fixture('ready-gift', true)
    try {
        const goods = tables.get('mall_pay_goods').find((row) => row.goodsId === 20101),
            shop = tables
                .get('mall_shop')
                .find((row) => String(row.goodsListPurchase).split('|').map(Number).includes(goods.goodsId)),
            before = new Map(
                parseRewards(goods.item)
                    .filter((reward) => reward.itemtype === 3)
                    .map((reward) => [reward.itemid, f.client.inventory.count(reward.itemid)]),
            ),
            request = {
                pay_shop_id: shop.shopId,
                pay_goods_id: goods.goodsId,
                buy_count: 1,
                product_id: 'lurukaps-offline:current-gift:local',
                amount: '0',
            },
            packets = f.call('PlayerMallCreatePayOrder', request)
        assert.equal(f.client.presentations.length, 1)
        for (const reward of parseRewards(goods.item).filter((reward) => reward.itemtype === 3))
            assert.equal(f.client.inventory.count(reward.itemid), before.get(reward.itemid) + reward.itemnum)
        assert.deepEqual(
            f.client.presentations[0].rewards,
            protocol.decode(protocol.byId.get(18048).rsp, packets.find((packet) => packet.id === 18048).payload)
                .mall_data.pay_rewards.rewards,
        )
        assert.equal(f.client.queries.length, 2, '18036 and the nonempty18048 each request another receipt')
        assert.equal(drain(f), 2)
        assert.equal(f.client.presentations.length, 1)
        assert.equal(f.client.sdkAttempts, 0)
        assert(packets.findIndex((packet) => packet.id === 18036) < packets.findIndex((packet) => packet.id === 18048))
        f.call('PlayerMallCreatePayOrder', request)
        drain(f)
        assert.equal(f.client.presentations.length, 1)
    } finally {
        f.store.close()
    }
})

test('current18031 normal mall purchase displays its ACK rewards with soul instance sync, without a recharge receipt', () => {
    const f = fixture('ordinary')
    try {
        const goods = tables
                .get('mall_goods')
                .find(
                    (row) =>
                        parseRewards(row.item).some((reward) => reward.itemtype === 9) &&
                        parseRewards(row.costId).every((cost) => cost.itemtype === 3),
                ),
            shop = tables
                .get('mall_shop')
                .find((row) => String(row.goodsList).split('|').map(Number).includes(goods.goodsId))
        assert(goods && shop)
        const costs = parseRewards(goods.costId)
        f.edit((state) => {
            for (const cost of costs)
                state.player.sbag_infos.items.push({ itemid: cost.itemid, itemnum: cost.itemnum, itemtype: 3 })
        })
        const packets = f.call('PlayerMallBuyDiamondGoods', {
            diamond_shop_id: shop.shopId,
            diamond_goods_id: goods.goodsId,
            buy_count: 1,
        })
        assert.equal(f.client.presentations.length, 1)
        assert(f.client.presentations[0].rewards.some((reward) => reward.itemtype === 9))
        assert.equal(
            packets.some((packet) => packet.id === 18048),
            false,
        )
        assert.equal(f.client.queries.length, 0)
    } finally {
        f.store.close()
    }
})

test('current18048 pay_source1 queues web rewards until the empty receipt terminates draining; pay_source0 presents immediately', () => {
    const rewards = { rewards: [{ itemtype: 3, itemid: tables.get('common_item')[0].id, itemnum: 1 }] },
        payload = {
            popup_id: 1,
            pay_source: 1,
            purchase_sdk_id: tables.get('purchase_sdk')[0].id,
            mall_data: { pay_rewards: rewards },
        },
        packet = (data) => ({ id: 18048, payload: protocol.encode(protocol.byId.get(18048).rsp, data) }),
        web = new MallConsumer(),
        direct = new MallConsumer()
    web.consume([packet(payload)])
    assert.equal(web.presentations.length, 0)
    assert.equal(web.web.length, 1)
    web.consume([packet({ popup_id: 0 })])
    assert.equal(web.presentations.length, 1)
    assert.equal(web.web.length, 0)
    direct.consume([packet({ ...payload, pay_source: 0 })])
    assert.equal(direct.presentations.length, 1)
    direct.consume([packet({ popup_id: 0 })])
    assert.equal(direct.presentations.length, 1)
})
