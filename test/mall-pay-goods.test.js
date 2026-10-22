import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { MallCatalog } from '../src/mall.js'
import { mallConditions } from '../src/mall-conditions.js'
import { cosmeticOwnedCount } from '../src/appearance-rewards.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { payGoodsPlan } from '../src/mall-pay-goods.js'
import { mallScheduleOpen, mallTableRow } from '../src/mall-schedule.js'
import { configTime } from '../src/shops.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const current = tables.get('mall_pay_goods').filter((x) => x.costPurchaseDiamondNum > 0)
const shopFor = (id) =>
    tables.get('mall_shop').find((s) => String(s.goodsListPurchase).split('|').map(Number).includes(id)).shopId
const currency = (s, id) => BigInt(s.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? '0')
const request = (id) => ({ pay_shop_id: shopFor(id), pay_goods_id: id, buy_count: 1 })
function fixture(filename = ':memory:', options = {}) {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, offlinePayments: true, ...options })
    let seq = 1,
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'mall-paid-test' })
    }
    login()
    return {
        store,
        game,
        call,
        login,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        close: () => store.close(),
    }
}
function bank(s, paid = 20000, bonus = 100) {
    for (const [id, num] of [
        [901, paid],
        [902, bonus],
    ]) {
        let attr = s.player.attr_infos.attrs.find((a) => a.attr_id === id)
        if (!attr) s.player.attr_infos.attrs.push((attr = { attr_id: id, attr_val: '0' }))
        attr.attr_val = String(num)
    }
    s.petSkins = []
    s.unlockedClothes = []
    s.unlockedHeroSkins = {}
    if (s.home?.dorm?.back_ground_scene) s.home.dorm.back_ground_scene.rewards = []
}
test('18033 all eight current diamond-priced pay goods debit real901+902 and grant each cosmetic via its ownership channel before ACK', () => {
    assert.equal(current.length, 8)
    for (const goods of current) {
        // Full snapshots are required here because the fixture deliberately
        // removes the default offline entitlements already sent at login.
        const f = fixture(':memory:', { syncOptimization: false })
        try {
            f.edit((s) => bank(s))
            const before = structuredClone(f.state()),
                packets = f.call('PlayerMallBuyPayGoods', request(goods.goodsId)),
                ack = packets.find((p) => p.id === 18033),
                after = f.state()
            assert(ack)
            assert.equal(ack.data.pay_goods.goods_id, goods.goodsId)
            assert.equal(ack.data.pay_goods.curr_purchase_num, 1)
            assert.equal(ack.data.pay_goods.is_all_cond_done, false)
            assert.equal(currency(after, 902), 0n)
            assert.equal(currency(after, 901), 20000n - BigInt(goods.costPurchaseDiamondNum - 100))
            assert.equal(after.player.basic_info.diamond, before.player.basic_info.diamond)
            const first = parseRewards(goods.item)[0]
            assert.equal(cosmeticOwnedCount(tables, after, first.itemtype, first.itemid), 1)
            assert(
                ack.data.pay_rewards.rewards.some(
                    (r) => r.itemtype === first.itemtype && r.itemid === first.itemid && r.itemnum === 1,
                ),
            )
            assert(
                !after.player.sbag_infos.items.some((r) => r.itemid === first.itemid),
                'Cosmetic must not become a fake common-item stack',
            )
            assert(!packets.some((p) => [18038, 18039, 18040].includes(p.id)))
            assert.equal(after.mall.localOrders, undefined)
            assert.equal(after.mall.popupQueue, undefined)
            const syncName =
                first.itemtype === 37
                    ? 'CSProtoPetSkinInfoSync'
                    : first.itemtype === 34
                      ? 'SCProtoClothesInfoSync'
                      : first.itemtype === 39
                        ? 'SCProtoHeroSkinMessageSync'
                        : 'CSProtoHomeSync'
            const syncId = protocol.byName.get(syncName)?.id
            assert.ok(syncId, 'Expected current cosmetic sync protocol')
            assert(
                packets.some((p, i) => p.id === syncId && i < packets.findIndex((p) => p.id === 18033)),
                JSON.stringify({
                    goods: goods.goodsId,
                    syncId,
                    packets: packets.map((p) => p.id),
                    homeRevision: after.homeRevision,
                    appearanceRevision: after.appearanceRevision,
                }),
            )
            const state = structuredClone(after)
            assert.throws(
                () => f.call('PlayerMallBuyPayGoods', request(goods.goodsId)),
                (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
            )
            assert.deepEqual(f.state(), state)
        } finally {
            f.close()
        }
    }
})
test('mall HaveItem12081 is exact equality including zero, and unsupported future resource conditions never silently pass', () => {
    const f = fixture()
    try {
        f.edit((s) => bank(s))
        assert.equal(mallConditions(tables, f.state(), '12081#37#200002#0').passed, true)
        f.call('PlayerMallBuyPayGoods', request(30202))
        assert.equal(mallConditions(tables, f.state(), '12081#37#200002#0').passed, false)
        assert.equal(mallConditions(tables, f.state(), '12081#37#200002#1').passed, true)
        assert.equal(mallConditions(tables, f.state(), '12081#37#200002#2').passed, false)
        const unknown = mallConditions(tables, f.state(), '12081#999#1#0')
        assert.equal(unknown.supported, false)
        assert.equal(unknown.passed, false)
        const catalog = new MallCatalog(tables)
        catalog.pay.set(30203, { ...catalog.pay.get(30203), commonCondition: '12081#999#1#0' })
        assert.throws(
            () => payGoodsPlan({ state: f.state(), tables, now: 1800000000 }, request(30203), catalog),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
    } finally {
        f.close()
    }
})
test('18033 rejects wrong shop, cash-only zero price, invalid quantity, quota, insufficient/debt currency and corrupt balances atomically', () => {
    const f = fixture()
    try {
        f.edit((s) => bank(s))
        for (const [r, code] of [
            [{ ...request(30202), pay_shop_id: 99999 }, ErrorCode.MallShopNotExist],
            [{ ...request(30202), pay_shop_id: 201 }, ErrorCode.MallGoodsNotExist],
            [request(20101), ErrorCode.MallBuyTypeInvalid],
            [{ ...request(30202), buy_count: 0 }, ErrorCode.InvalidArgument],
            [{ ...request(30202), buy_count: 101 }, ErrorCode.MallBuyCountError],
            [{ ...request(30202), buy_count: 2 }, ErrorCode.MallGoodsNumLimit],
        ]) {
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('PlayerMallBuyPayGoods', r),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        for (const [edit, code] of [
            [(s) => bank(s, 0, 0), ErrorCode.ItemNotEnough],
            [
                (s) => {
                    bank(s)
                    s.mallDebtPack = { debt_list: [{ item_type: 10, item_id: 901, item_debt: '1' }] }
                },
                ErrorCode.FunctionClosed,
            ],
            [
                (s) => {
                    bank(s)
                    delete s.mallDebtPack
                    s.player.attr_infos.attrs.find((a) => a.attr_id === 902).attr_val = '-1'
                },
                ErrorCode.GameConfig,
            ],
        ]) {
            f.edit(edit)
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('PlayerMallBuyPayGoods', request(30202)),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.close()
    }
})
test('18033 cosmetic, player and ACK codecs all roll back debit, ownership, card grants and quota', () => {
    for (const [goodsId, name] of [
        [30401, 'SCProtoClothesInfoSync'],
        [30301, 'SCProtoHeroSkinMessageSync'],
        [30202, 'CSProtoPetSkinInfoSync'],
        [30203, 'CSProtoSyncPlayerData'],
        [30204, 'CSProtoPlayerMallBuyPayGoods'],
    ]) {
        const f = fixture(),
            encode = f.game.protocol.encode.bind(f.game.protocol)
        try {
            f.edit((s) => bank(s))
            const before = structuredClone(f.state()),
                type = protocol.byName.get(name).rsp
            f.game.protocol.encode = (current, value) => {
                if (current === type) throw Error('paid-goods codec')
                return encode(current, value)
            }
            assert.throws(() => f.call('PlayerMallBuyPayGoods', request(goodsId)), /paid-goods codec/)
            f.game.protocol.encode = encode
            assert.deepEqual(f.state(), before)
        } finally {
            f.game.protocol.encode = encode
            f.close()
        }
    }
})
test('18033 and the offline order route share the same purchase quota and unique cosmetic entitlement', () => {
    const f = fixture()
    try {
        f.edit((s) => bank(s))
        f.call('PlayerMallCreatePayOrder', {
            ...request(30202),
            product_id: 'lurukaps-offline:mall-pay-0001:local',
            amount: '0',
        })
        const before = structuredClone(f.state())
        assert.equal(before.petSkins.includes(200002), true)
        assert.equal(before.mall.purchases['pay:30202'].count, 1)
        assert.throws(
            () => f.call('PlayerMallBuyPayGoods', request(30202)),
            (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
test('34/39 rewards outside the mall use the same unique unlocks without changing equipped appearance', () => {
    const f = fixture()
    try {
        const s = structuredClone(f.state())
        bank(s)
        const original = structuredClone(s.player.basic_info.clothes_info),
            heroSkins = s.player.heros_info.heros.map((h) => [h.guid, h.skin_id])
        const rewards = [
            { itemtype: 34, itemid: 10002, itemnum: 1 },
            { itemtype: 39, itemid: 1010101, itemnum: 1 },
        ]
        const base = structuredClone(s),
            borrowedDraft = { ...s }
        assert.equal(grantRewards(tables, borrowedDraft, rewards).length, 2)
        assert.deepEqual(s, base, 'A failed combat draft cannot mutate borrowed ownership')
        assert.equal(grantRewards(tables, s, rewards).length, 2)
        assert.equal(grantRewards(tables, s, rewards).length, 0)
        assert.equal(s.appearanceRevision, 2)
        assert.deepEqual(s.player.basic_info.clothes_info, original)
        assert.deepEqual(
            s.player.heros_info.heros.map((h) => [h.guid, h.skin_id]),
            heroSkins,
        )
    } finally {
        f.close()
    }
})
test('current fresh schedule overrides only known stale values; missing998002 is an explicit local open-ended policy, other missing IDs remain errors', () => {
    const row = tables.get('mall_pay_goods').find((row) => row.goodsId === 30301)
    assert.equal(mallTableRow('mall_pay_goods', row).timelimit, 998002)
    assert.equal(mallTableRow('mall_pay_goods', { ...row, timelimit: 999777 }).timelimit, 999777)
    assert.equal(mallScheduleOpen(tables, 998002, 1800000000), true)
    const dated = tables.find('common_timelimit', 30001),
        start = configTime(dated.startTime),
        end = configTime(dated.endTime)
    assert.equal(mallScheduleOpen(tables, 30001, start - 1), false)
    assert.equal(mallScheduleOpen(tables, 30001, start), true)
    assert.equal(mallScheduleOpen(tables, 30001, end), true)
    assert.equal(mallScheduleOpen(tables, 30001, end + 1), false)
    assert.throws(
        () => mallScheduleOpen(tables, 999777, 1800000000),
        (e) => e.code === ErrorCode.MallConfigError,
    )
    const catalog = new MallCatalog(tables),
        f = fixture()
    try {
        f.edit((s) => bank(s))
        catalog.pay.set(30202, { ...catalog.pay.get(30202), timelimit: 30001 })
        assert.throws(
            () => payGoodsPlan({ tables, state: f.state(), now: 1800000000 }, request(30202), catalog),
            (e) => e.code === ErrorCode.MallBuyTimeInvalid,
        )
    } finally {
        f.close()
    }
})
test('18033 quota, paid balance and ownership survive SQLite close/reopen and login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-mallpay-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture(file)
    try {
        f.edit((s) => bank(s))
        f.call('PlayerMallBuyPayGoods', request(30202))
        f.close()
        f = fixture(file)
        assert.equal(f.state().petSkins.includes(200002), true)
        assert.equal(f.state().mall.purchases['pay:30202'].count, 1)
        assert.equal(currency(f.state(), 901), 19720n)
        assert.equal(currency(f.state(), 902), 0n)
        assert.throws(
            () => f.call('PlayerMallBuyPayGoods', request(30202)),
            (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
    } finally {
        f.close()
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
        assert(path.basename(dir).startsWith('lurukaps-mallpay-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
