import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { ordinaryGoodsPricing } from '../src/shop-pricing.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    target = 2040402,
    shop = 200024
function fixture({ level = 40, cash = 1000000 } = {}) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let seq = 1,
        session = {},
        last
    const game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 })
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) }
    }
    const dispatch = (r, who = session) => {
        last = game.dispatch(who, r)
        const e = protocol.byId.get(r.id)
        return e.rsp ? protocol.decode(e.rsp, last.find((p) => p.id === r.id).payload) : undefined
    }
    const call = (name, data) => dispatch(frame(name, data))
    const login = () => {
        const next = {}
        dispatch(frame('EnterGame', { open_id: 'shop-special-current' }), next)
        session = next
        return last
    }
    login()
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = level
        if (cash) grantRewards(tables, s, [{ itemtype: 10, itemid: 103, itemnum: cash }])
    })
    call('Ping', {})
    return {
        protocol,
        store,
        game,
        frame,
        dispatch,
        call,
        login,
        packets: () => last,
        state: () => store.load(session.id).state,
        saved: () => store.load(session.id),
        cash: () =>
            BigInt(
                store.load(session.id).state.player.attr_infos.attrs.find((a) => a.attr_id === 103)?.attr_val ?? '0',
            ),
        buy: (times = 1) =>
            call('ShopBuyItems', { shop_id: shop, items: [{ slot_id: target, goods_id: target, times }] }),
        close: () => store.close(),
    }
}
const itemCount = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, r) => n + r.itemnum, 0)
const eggs = (f) => f.state().petEggs.filter((e) => e.configid === 30101003)
function row(f, packets, shopId, slot) {
    const id = f.protocol.byName.get('SCProtoShopInfoSync').id
    const p = packets.find(
        (p) => p.id === id && f.protocol.decode(f.protocol.byId.get(id).rsp, p.payload).shop_id === shopId,
    )
    assert(p)
    return f.protocol
        .decode(f.protocol.byId.get(id).rsp, p.payload)
        .shop_info.shop_items.find((x) => x.slot_id === slot)
}
test('all300 current ordinary goods retain raw payable costs, including97 strike-price rows and the real zero-cost10000 special', () => {
    let promoted = 0
    for (const goods of tables.get('goods')) {
        const model = ordinaryGoodsPricing(goods)
        assert.deepEqual(model.costs, parseRewards(goods.costId, true))
        if (goods.specialPrice) {
            promoted++
            if (model.costs[0]?.itemnum > 0) {
                const n = BigInt(model.costs[0].itemnum) * 10000n,
                    d = BigInt(10000 - goods.specialPrice)
                assert.equal(model.originalUnitPrice, Number((n + d - 1n) / d))
            } else assert.equal(model.originalUnitPrice, null)
        }
    }
    assert.equal(promoted, 97)
    assert.equal(
        ordinaryGoodsPricing(tables.get('goods').find((row) => row.goodsId === target)).originalUnitPrice,
        200000,
    )
})
test('real2040402 ShopInfo and ShopBuyItems spend10000 ofcurrency103, grant egg30101003 before ACK and return the updated stock snapshot', () => {
    const f = fixture()
    try {
        f.call('ShopInfoReq', { shop_id: shop })
        assert.equal(row(f, f.packets(), shop, target).shop_store_num, 30)
        const before = f.cash(),
            gold = f.state().player.basic_info.gold,
            result = f.buy()
        assert.equal(before - f.cash(), 10000n)
        assert.equal(f.state().player.basic_info.gold, gold, 'currency103 is not basic_info.gold')
        assert.equal(eggs(f).length, 1)
        assert.equal(eggs(f)[0].hatch_state, 0)
        assert(
            result.rewards
                .flatMap((r) => r.rewards)
                .some((r) => r.itemtype === 14 && r.itemid === 30101003 && r.itemnum === 1),
        )
        const ids = f.packets().map((p) => p.id),
            ack = f.protocol.byName.get('CSProtoShopBuyItems').id,
            egg = f.protocol.byName.get('CSProtoPetEggInfoSync').id
        assert(ids.indexOf(egg) >= 0 && ids.indexOf(egg) < ids.indexOf(ack))
        assert.equal(row(f, f.packets(), shop, target).buy_times, 1)
        assert.equal(f.state().shopPurchases[`${shop}:${target}`].count, 1)
        if (process.env.LURUKAPS_SHOP_PRICING_EVIDENCE)
            fs.writeFileSync(
                process.env.LURUKAPS_SHOP_PRICING_EVIDENCE,
                JSON.stringify(
                    {
                        request: { shop_id: shop, items: [{ slot_id: target, goods_id: target, times: 1 }] },
                        currencyId: 103,
                        spent: String(before - f.cash()),
                        basicGoldUnchanged: f.state().player.basic_info.gold === gold,
                        egg: {
                            guid: eggs(f)[0].guid,
                            configid: eggs(f)[0].configid,
                            hatch_state: eggs(f)[0].hatch_state,
                            egg_affix: eggs(f)[0].egg_affix,
                        },
                        response: result,
                        slot: row(f, f.packets(), shop, target),
                        packetIds: ids,
                    },
                    null,
                    2,
                ) + '\n',
            )
        f.login()
        f.call('ShopInfoReq', { shop_id: shop })
        assert.equal(row(f, f.packets(), shop, target).buy_times, 1)
        assert.equal(eggs(f).length, 1)
    } finally {
        f.close()
    }
})
test('actual free2050101 special10000 grants one current card without a fee or divide-by-zero and keeps permanent one-time stock', () => {
    const f = fixture({ cash: 0 })
    try {
        const count = itemCount(f.state(), 1000002),
            cash = f.cash()
        f.call('ShopBuyItems', { shop_id: 200023, items: [{ slot_id: 2050101, goods_id: 2050101, times: 1 }] })
        assert.equal(itemCount(f.state(), 1000002) - count, 1)
        assert.equal(f.cash(), cash)
        const before = f.saved()
        assert.throws(
            () =>
                f.call('ShopBuyItems', { shop_id: 200023, items: [{ slot_id: 2050101, goods_id: 2050101, times: 1 }] }),
            { code: ErrorCode.ShopGoodsConfLimit },
        )
        assert.deepEqual(f.saved(), before)
    } finally {
        f.close()
    }
})
test('quantity/duplicates/stock30 and level/currency boundaries reject atomically before refunds or reward creation', () => {
    const f = fixture()
    try {
        for (const [items, code] of [
            [[], ErrorCode.ShopGoodsTimes],
            [[{ slot_id: target, goods_id: target, times: 0 }], ErrorCode.ShopGoodsTimes],
            [[{ slot_id: target, goods_id: target, times: 31 }], ErrorCode.ShopGoodsConfLimit],
            [
                [
                    { slot_id: target, goods_id: target, times: 20 },
                    { slot_id: target, goods_id: target, times: 11 },
                ],
                ErrorCode.ShopGoodsConfLimit,
            ],
            [
                [
                    { slot_id: target, goods_id: target, times: 0xffffffff },
                    { slot_id: target, goods_id: target, times: 1 },
                ],
                ErrorCode.InvalidArgument,
            ],
        ]) {
            const before = f.saved()
            assert.throws(() => f.call('ShopBuyItems', { shop_id: shop, items }), { code })
            assert.deepEqual(f.saved(), before)
        }
        const before = f.cash()
        f.call('ShopBuyItems', {
            shop_id: shop,
            items: [
                { slot_id: target, goods_id: target, times: 10 },
                { slot_id: target, goods_id: target, times: 20 },
            ],
        })
        assert.equal(before - f.cash(), 300000n)
        assert.equal(eggs(f).length, 30)
        const full = f.saved()
        assert.throws(() => f.buy(), { code: ErrorCode.ShopGoodsConfLimit })
        assert.deepEqual(f.saved(), full)
    } finally {
        f.close()
    }
    for (const [options, code] of [
        [{ level: 39 }, ErrorCode.ShopItemUnlock],
        [{ cash: 9999 }, ErrorCode.ItemNotEnough],
    ]) {
        const f = fixture(options)
        try {
            const before = f.saved()
            assert.throws(() => f.buy(), { code })
            assert.deepEqual(f.saved(), before)
        } finally {
            f.close()
        }
    }
})
test('actual egg purchase response codec/SQL failure roll back fee, RNG outcome, stock and identity; original request retry grants one egg', () => {
    const f = fixture()
    try {
        const r = f.frame('ShopBuyItems', { shop_id: shop, items: [{ slot_id: target, goods_id: target, times: 1 }] }),
            before = f.saved(),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byName.get('CSProtoShopBuyItems').rsp) throw Error('shop-price-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.dispatch(r), /shop-price-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.saved(), before)
        f.store.db.exec(
            "CREATE TRIGGER shop_price_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'shop-price-sql'); END",
        )
        try {
            assert.throws(() => f.dispatch(r), /shop-price-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER shop_price_abort')
        }
        assert.deepEqual(f.saved(), before)
        f.dispatch(r)
        assert.equal(eggs(f).length, 1)
        assert.equal(f.state().shopPurchases[`${shop}:${target}`].count, 1)
    } finally {
        f.close()
    }
})
test('conditional rounding vectors follow native per-unitCeiling before quantity; malformed/dynamic pricing is never silently accepted', () => {
    const actual = tables.get('goods').find((row) => row.goodsId === target)
    // These are independent mathematical contract vectors, not fabricated
    // current shop offers. All actual97 promoted rows divide exactly.
    const v = ordinaryGoodsPricing({ ...actual, costId: '10#103#1', specialPrice: 3333 })
    assert.equal(v.originalUnitPrice, 2)
    assert.equal(v.originalUnitPrice * 3, 6)
    assert.notEqual(v.originalUnitPrice * 3, Math.ceil((3 * 10000) / 6667))
    assert.equal(v.costs[0].itemnum * 3, 3)
    assert.equal(
        ordinaryGoodsPricing({ ...actual, costId: '10#103#4294967295', specialPrice: 9999 }).originalUnitPrice,
        42949672950000,
    )
    for (const specialPrice of [-1, 10001, 1.5, '9500'])
        assert.throws(() => ordinaryGoodsPricing({ ...actual, specialPrice }), { code: ErrorCode.GameConfig })
    assert.throws(() => ordinaryGoodsPricing({ ...actual, specialPrice: 10000 }), { code: ErrorCode.GameConfig })
    assert.throws(() => ordinaryGoodsPricing({ ...actual, recommend: 'unrecovered' }), {
        code: ErrorCode.FunctionClosed,
    })
})
