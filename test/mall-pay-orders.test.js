import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { LOCAL_CALLBACK_NOTICE } from '../src/handlers/local-payments.js'
import { parseRewards } from '../src/rewards.js'
import { cosmeticOwnedCount } from '../src/appearance-rewards.js'
const config = configuration(),
    tables = new Tables(config.tables)
const goods = tables.get('mall_pay_goods'),
    shopFor = (id) =>
        tables.get('mall_shop').find((s) => String(s.goodsListPurchase).split('|').map(Number).includes(id)).shopId
const order = (id, nonce = 'b06-cash-' + id) => ({
    pay_shop_id: shopFor(id),
    pay_goods_id: id,
    buy_count: 1,
    product_id: `lurukaps-offline:${nonce}:local-test-product`,
    amount: '0',
})
const balance = (s) => [901, 902].map((id) => s.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? '0')
function fixture() {
    let now = 1800000000,
        seq = 1
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now, offlinePayments: true }),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'cash-goods-test' })
    store.transact(session.id, 0, (s) => {
        s.petSkins = []
        s.unlockedClothes = []
        s.unlockedHeroSkins = {}
        if (s.home?.dorm?.back_ground_scene) s.home.dorm.back_ground_scene.rewards = []
    })
    return {
        protocol,
        store,
        game,
        call,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        time: (value) => (now = value),
        close: () => store.close(),
    }
}
test('18034 all23 current pay goods fulfill actual configured rewards once through the non-actionable offline order channel', () => {
    assert.equal(goods.length, 23)
    for (const row of goods) {
        const f = fixture()
        try {
            const before = balance(f.state()),
                request = order(row.goodsId),
                packets = f.call('PlayerMallCreatePayOrder', request)
            const noticeId = f.protocol.byName.get('SCProtoPlayerMallCreatePayOrderNtf').id,
                successId = f.protocol.byName.get('SCProtoPlayerMallPaySuccessNtf').id
            const notice = packets.find((p) => p.id === noticeId)?.data,
                success = packets.find((p) => p.id === successId)?.data
            assert(notice && success, 'Both async mall channels must be present')
            assert.equal(notice.errcode, LOCAL_CALLBACK_NOTICE)
            assert.equal(notice.purchase_sdk_id, 0)
            assert.equal(notice.callback_url, undefined)
            assert.equal(notice.order_sign, undefined)
            assert.equal(notice.pay_goods_id, row.goodsId)
            assert.equal(success.pay_goods_id, row.goodsId)
            assert.deepEqual(balance(f.state()), before, 'Offline simulation does not charge paid currency')
            assert.equal(f.state().mall.purchases['pay:' + row.goodsId].count, 1)
            const receipt = f.state().mall.localOrders['b06-cash-' + row.goodsId]
            assert.equal(receipt.purchase_sdk_id, row.purchaseSdkID)
            assert.equal(receipt.gift.pay_goods_id, row.goodsId)
            for (const expected of parseRewards(row.item)) {
                assert(
                    success.pay_rewards.rewards.some(
                        (r) =>
                            r.itemtype === expected.itemtype &&
                            r.itemid === expected.itemid &&
                            r.itemnum === expected.itemnum,
                    ),
                )
                if ([34, 37, 39, 40].includes(expected.itemtype))
                    assert.equal(cosmeticOwnedCount(tables, f.state(), expected.itemtype, expected.itemid), 1)
                if (expected.itemtype === 3)
                    assert(
                        f
                            .state()
                            .player.sbag_infos.items.some(
                                (r) => r.itemid === expected.itemid && r.itemnum >= expected.itemnum,
                            ),
                    )
            }
            const owned = structuredClone(f.state()),
                counters = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
            const replay = f.call('PlayerMallCreatePayOrder', request)
            assert.equal(replay.find((p) => p.id === noticeId).data.order_id, notice.order_id)
            assert.deepEqual(f.state(), owned)
            assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), counters)
        } finally {
            f.close()
        }
    }
})
test('18034 new requests enforce shared ownership/stock before allocating order IDs, while an existing receipt replays after ownership changes', () => {
    const f = fixture()
    try {
        const request = order(30202),
            packets = f.call('PlayerMallCreatePayOrder', request),
            before = structuredClone(f.state())
        assert(packets.some((p) => p.id === 18034))
        const counters = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
        assert.throws(
            () => f.call('PlayerMallCreatePayOrder', order(30202, 'b06-new-owner')),
            (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), counters)
        const changed = { ...request, amount: '1' }
        assert.throws(() => f.call('PlayerMallCreatePayOrder', changed), /nonce reused/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
test('18034 invalid shop, membership and count leave wallet, delivery queue, quota and sequence allocation untouched', () => {
    const f = fixture()
    try {
        for (const [request, code] of [
            [{ ...order(20101), pay_shop_id: 99999 }, ErrorCode.MallShopNotExist],
            [{ ...order(20101), pay_shop_id: 302 }, ErrorCode.MallGoodsNotExist],
            [{ ...order(20101), buy_count: 0 }, ErrorCode.InvalidArgument],
            [{ ...order(20101), buy_count: 101 }, ErrorCode.MallBuyCountError],
            [{ ...order(20101), buy_count: 2 }, ErrorCode.MallGoodsNumLimit],
        ]) {
            const before = structuredClone(f.state()),
                counters = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
            assert.throws(
                () => f.call('PlayerMallCreatePayOrder', request),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
            assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), counters)
        }
    } finally {
        f.close()
    }
})
test('18034 async delivery and ownership encoding failures roll back the whole offline purchase and can retry the same nonce once', () => {
    for (const [id, name] of [
        [30202, 'SCProtoPlayerMallCreatePayOrderNtf'],
        [30203, 'SCProtoPlayerMallPaySuccessNtf'],
        [30301, 'SCProtoHeroSkinMessageSync'],
        [30401, 'SCProtoClothesInfoSync'],
        [20101, 'CSProtoPlayerMallCreatePayOrder'],
    ]) {
        const f = fixture(),
            encode = f.protocol.encode.bind(f.protocol)
        try {
            const before = structuredClone(f.state()),
                request = order(id),
                type = f.protocol.byName.get(name).rsp
            f.protocol.encode = (current, value) => {
                if (current === type) throw Error('cash order codec')
                return encode(current, value)
            }
            assert.throws(() => f.call('PlayerMallCreatePayOrder', request), /cash order codec/)
            f.protocol.encode = encode
            assert.deepEqual(f.state(), before)
            f.call('PlayerMallCreatePayOrder', request)
            assert.equal(f.state().mall.purchases['pay:' + id].count, 1)
            assert.equal(Object.values(f.state().mall.localOrders).length, 1)
        } finally {
            f.protocol.encode = encode
            f.close()
        }
    }
})
