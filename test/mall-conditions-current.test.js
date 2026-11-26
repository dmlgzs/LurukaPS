import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { mallConditions } from '../src/mall-conditions.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { ObtAppearanceConsumer } from './helpers/obt-appearance-consumer.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const diamond = new Map(tables.get('mall_goods').map((row) => [row.goodsId, row]))
const pay = new Map(tables.get('mall_pay_goods').map((row) => [row.goodsId, row]))
const shopFor = (id, isPay) =>
    tables.get('mall_shop').find((row) =>
        String(isPay ? row.goodsListPurchase : row.goodsList)
            .split('|')
            .map(Number)
            .includes(id),
    ).shopId

// Current ShopStore0601c9e5/e6/e8/e9: process is cached server bool, missing
// segments are local checks. Model the actual table indexing and cached stock,
// not a server-state lookup. Ownership comes from dedicated sync channels.
class Consumer {
    constructor() {
        this.goods = new Map()
        this.appearance = new ObtAppearanceConsumer(tables, protocol)
        this.vehicles = new Map()
        this.petSkins = new Set()
        this.dorm = new Set()
        this.requests = []
    }
    consume(packets) {
        for (const packet of packets) {
            const entry = protocol.byId.get(packet.id),
                data = protocol.decode(entry.rsp, packet.payload)
            if (
                [5001, 5008].includes(packet.id) ||
                ['SCProtoClothesInfoSync', 'SCProtoHeroSkinMessageSync'].includes(entry.name)
            )
                this.appearance.consume(packet)
            if (packet.id === 6592)
                for (const row of data.owned_vehicles ?? []) this.vehicles.set(row.guid, row.conf_id)
            if (packet.id === 6549) for (const row of data.skin_infos ?? []) this.petSkins.add(row.skin_id)
            if (packet.id === 6102)
                for (const row of data.dorm?.back_ground_scene?.rewards ?? [])
                    if (row.itemnum > 0) this.dorm.add(row.itemid)
            // HandleSuccessCurrencyBuy0601ca13 requests this shop's current
            // goods, then RefreshPurchaseGoodsAfterBought0601ca18 increments
            // its cached product by one. The later list is authoritative.
            if (packet.id === 18036) {
                const shop = tables.get('mall_shop').find((row) => row.shopId === data.pay_shop_id)
                assert(shop)
                if (shop.goodsList)
                    this.requests.push(['PlayerMallGetDiamondGoodsList', { diamond_shop_id: shop.shopId }])
                if (shop.goodsListPurchase)
                    this.requests.push(['PlayerMallGetPayGoodsList', { pay_shop_id: shop.shopId }])
                const old = this.goods.get(data.pay_goods_id)
                if (old) old.curr_purchase_num = (old.curr_purchase_num ?? 0) + 1
            }
            const rows = [
                ...(data.diamond_goods_list ?? []),
                ...(data.pay_goods_list ?? []),
                ...[
                    data.diamond_goods,
                    data.pay_goods,
                    data.mall_data?.diamond_goods,
                    data.mall_data?.pay_goods,
                ].filter(Boolean),
            ]
            for (const wire of rows) {
                const row = (wire.is_pay_goods ? pay : diamond).get(wire.goods_id)
                assert(row)
                const terms = String(row.commonCondition)
                    .split('|')
                    .filter(Boolean)
                    .map((token) => token.split('#').map(Number))
                const targets = String(row.unlockParam).split('|').filter(Boolean).map(Number)
                assert.equal((wire.unlock_cond_id ?? []).length, (wire.unlock_progress ?? []).length)
                for (const [index, kind] of (wire.unlock_cond_id ?? []).entries()) {
                    const position = terms.findIndex((term) => term[0] === kind)
                    assert(position >= 0 && position < targets.length, 'Native unlockParam[index] must be readable')
                    if (wire.is_all_cond_done) assert.equal(wire.unlock_progress[index], targets[position])
                }
                this.goods.set(row.goodsId, structuredClone(wire))
            }
        }
    }
    owned(type, id) {
        if (type === 41) return [...this.vehicles.values()].includes(id) ? 1 : 0
        if (type === 34) return this.appearance.unlockedClothes.has(id) ? 1 : 0
        if (type === 39)
            return this.appearance.skinOwnership
                .get(tables.get('hero_clothing').find((row) => row.clothingid === id).hero)
                ?.has(id)
                ? 1
                : 0
        if (type === 37) return tables.find('pet_skin', id).isNormal === 1 || this.petSkins.has(id) ? 1 : 0
        if (type === 40) return this.dorm.has(id) ? 1 : 0
        throw Error('Unproven client ownership channel')
    }
    soldOut(type, id) {
        const isPay = pay.has(id)
        if ((type === 1 && isPay) || (type === 2 && !isPay) || ![1, 2].includes(type)) return false
        const row = (isPay ? pay : diamond).get(id),
            wire = this.goods.get(id)
        return !!row && !!wire && row.goodsNum > 0 && (wire.curr_purchase_num ?? 0) >= row.goodsNum
    }
    unlocked(id) {
        const row = pay.get(id) ?? diamond.get(id),
            wire = this.goods.get(id)
        assert(row && wire)
        if ((wire.unlock_cond_id ?? []).length && !wire.is_all_cond_done) return false
        return String(row.commonCondition)
            .split('|')
            .filter(Boolean)
            .every((token) => {
                const [kind, a, b, min, max] = token.split('#').map(Number)
                if ((wire.unlock_cond_id ?? []).includes(kind)) return true
                if (kind === 12280) return this.soldOut(a, b)
                if (kind === 12083) {
                    const count = this.owned(a, b)
                    return count >= min && count <= max
                }
                throw Error('Missing proven process condition')
            })
    }
}

function fixture(name) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, offlinePayments: true })
    let session = {},
        client = new Consumer(),
        seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(session, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
            })
        client.consume(packets)
        return packets
    }
    const account = 'mall-condition-current-' + name
    call('EnterGame', { open_id: account })
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((state) => {
        state.player.basic_info.lv = 70
        grantRewards(tables, state, [{ itemtype: 10, itemid: 901, itemnum: 50000 }])
    })
    const login = () => {
        session = {}
        client = new Consumer()
        call('EnterGame', { open_id: account, reconnect: true })
    }
    login()
    const query = (isPay, shopId) =>
        call(
            isPay ? 'PlayerMallGetPayGoodsList' : 'PlayerMallGetDiamondGoodsList',
            isPay ? { pay_shop_id: shopId } : { diamond_shop_id: shopId },
        )
    const drain = () => {
        let count = 0
        while (client.requests.length) {
            assert(count++ < 16)
            const [name, data] = client.requests.shift()
            call(name, data)
        }
        return count
    }
    return {
        store,
        game,
        call,
        edit,
        login,
        query,
        drain,
        get client() {
            return client
        },
        get session() {
            return session
        },
        state: () => store.load(session.id).state,
        snapshot: () => store.load(session.id),
    }
}
const sdkOrder = (id, nonce) => ({
    pay_shop_id: shopFor(id, true),
    pay_goods_id: id,
    buy_count: 1,
    product_id: `lurukaps-offline:${nonce}:mall-conditions`,
    amount: '0',
})
const currency = (state) =>
    [901, 902].reduce(
        (sum, id) => sum + BigInt(state.player.attr_infos.attrs.find((row) => row.attr_id === id)?.attr_val ?? 0),
        0n,
    )

test('all33 current affected goods expose only valid process indexes and leave12280/12083 to the current Native static path', () => {
    const f = fixture('matrix')
    try {
        const affected = [...diamond.values(), ...pay.values()].filter((row) =>
            /(?:12280|12083)#/.test(row.commonCondition),
        )
        assert.equal(affected.length, 33)
        for (const [isPay, rows] of [
            [false, [...diamond.values()]],
            [true, [...pay.values()]],
        ])
            for (const shop of new Set(
                rows.filter((row) => affected.includes(row)).map((row) => shopFor(row.goodsId, isPay)),
            ))
                f.query(isPay, shop)
        for (const row of affected) {
            const wire = f.client.goods.get(row.goodsId),
                condition = mallConditions(tables, f.state(), row.commonCondition)
            assert(condition.supported)
            assert(!(wire.unlock_cond_id ?? []).some((kind) => [12280, 12083].includes(kind)))
            assert.equal(f.client.unlocked(row.goodsId), condition.passed)
        }
    } finally {
        f.store.close()
    }
})

test('actual diamond predecessor purchase unlocks the cached next tier locally while direct server bypass, double claim and reconnect stay guarded', () => {
    const f = fixture('diamond')
    try {
        f.edit((state) => {
            state.player.basic_info.lv = 1
        })
        const lowLevel = f.snapshot()
        assert.throws(
            () => f.call('PlayerMallBuyDiamondGoods', { diamond_shop_id: 201, diamond_goods_id: 20501, buy_count: 1 }),
            (error) => error.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
        assert.deepEqual(f.snapshot(), lowLevel)
        f.edit((state) => {
            state.player.basic_info.lv = 70
        })
        f.query(false, 201)
        assert.equal(f.client.unlocked(20503), false)
        const cached = structuredClone(f.client.goods.get(20503)),
            before = f.snapshot()
        assert.throws(
            () => f.call('PlayerMallBuyDiamondGoods', { diamond_shop_id: 201, diamond_goods_id: 20503, buy_count: 1 }),
            (error) => error.code === ErrorCode.MallGoodsStaticCondInvalid,
        )
        assert.deepEqual(f.snapshot(), before)
        f.call('PlayerMallBuyDiamondGoods', { diamond_shop_id: 201, diamond_goods_id: 20501, buy_count: 1 })
        assert.deepEqual(
            f.client.goods.get(20503),
            cached,
            'No fictitious next-product purchase notification is needed',
        )
        assert.equal(f.client.unlocked(20503), true)
        f.call('PlayerMallBuyDiamondGoods', { diamond_shop_id: 201, diamond_goods_id: 20503, buy_count: 1 })
        const claimed = f.snapshot()
        assert.throws(() =>
            f.call('PlayerMallBuyDiamondGoods', { diamond_shop_id: 201, diamond_goods_id: 20503, buy_count: 1 }),
        )
        assert.deepEqual(f.snapshot(), claimed)
        f.login()
        f.query(false, 201)
        assert.equal(f.client.soldOut(1, 20503), true)
        assert.equal(f.state().mall.purchases['diamond:20503'].count, 1)
    } finally {
        f.store.close()
    }
})

test('actual offline pay ladder requires finite stock exhaustion rather than one purchase and preserves nonce retry and BeginTime history', () => {
    const f = fixture('pay-chain')
    try {
        f.query(true, 203)
        assert.equal(f.client.unlocked(20319), false)
        f.call('PlayerMallCreatePayOrder', sdkOrder(20309, 'mall-chain-first'))
        assert(f.drain() > 0)
        assert.equal(f.client.unlocked(20319), true)
        f.call('PlayerMallCreatePayOrder', sdkOrder(20319, 'mall-chain-second-a'))
        f.drain()
        assert.equal(f.client.unlocked(20329), false)
        assert.equal(f.state().mall.purchases['pay:20319'].count, 1)
        f.call('PlayerMallCreatePayOrder', sdkOrder(20319, 'mall-chain-second-b'))
        f.drain()
        assert.equal(f.client.unlocked(20329), true)
        f.call('PlayerMallCreatePayOrder', sdkOrder(20319, 'mall-chain-second-b'))
        f.drain()
        assert.equal(f.state().mall.purchases['pay:20319'].count, 2)
        assert.equal(f.client.goods.get(20319).curr_purchase_num, 2)
        f.login()
        f.query(true, 203)
        assert.equal(f.client.unlocked(20329), true)
        assert.equal(f.state().mall.purchases['pay:20319'].count, 2)
    } finally {
        f.store.close()
    }
})

test('actual ownership purchase updates the dedicated vehicle channel before ACK and rejects another SKU for the same owned item', () => {
    const f = fixture('owned')
    try {
        f.query(true, 305)
        assert.equal(f.client.unlocked(30501), true)
        const before = currency(f.state()),
            row = pay.get(30501),
            packets = f.call('PlayerMallBuyPayGoods', { pay_shop_id: 305, pay_goods_id: 30501, buy_count: 1 })
        assert(packets.findIndex((packet) => packet.id === 6592) < packets.findIndex((packet) => packet.id === 18033))
        assert.equal(before - currency(f.state()), BigInt(row.costPurchaseDiamondNum))
        assert.equal(f.client.unlocked(30501), false)
        assert.equal(f.client.unlocked(30502), false)
        const saved = f.snapshot()
        assert.throws(
            () => f.call('PlayerMallBuyPayGoods', { pay_shop_id: 305, pay_goods_id: 30502, buy_count: 1 }),
            (error) => error.code === ErrorCode.MallGoodsStaticCondInvalid,
        )
        assert.deepEqual(f.snapshot(), saved)
        for (const [min, max, expected] of [
            [0, 0, false],
            [1, 1, true],
            [0, 1, true],
            [1, 0, false],
        ])
            assert.equal(mallConditions(tables, f.state(), `12083#41#500927#${min}#${max}`).passed, expected)
    } finally {
        f.store.close()
    }
})

test('all five current ownership families honor existing availability policies, consume real purchase sync and survive reconnect', () => {
    const f = fixture('owned-families')
    try {
        const ids = [30202, 30301, 30401, 30501, 70101]
        for (const id of ids) {
            const shop = shopFor(id, true)
            f.query(true, shop)
            if ([30301, 30401, 70101].includes(id)) {
                // Existing local appearance policy already owns every current
                // hero/main-character costume and usable owned-hero dorm style.
                // Do not fabricate an unowned
                // online baseline or remove that policy to force a purchase.
                assert.equal(f.client.unlocked(id), false)
                const before = f.snapshot()
                assert.throws(
                    () => f.call('PlayerMallBuyPayGoods', { pay_shop_id: shop, pay_goods_id: id, buy_count: 1 }),
                    (error) => error.code === ErrorCode.MallGoodsStaticCondInvalid,
                )
                assert.deepEqual(f.snapshot(), before)
            } else {
                assert.equal(f.client.unlocked(id), true, `goods ${id} must start unowned`)
                f.call('PlayerMallBuyPayGoods', { pay_shop_id: shop, pay_goods_id: id, buy_count: 1 })
            }
            assert.equal(f.client.unlocked(id), false)
            assert.equal(mallConditions(tables, f.state(), pay.get(id).commonCondition).passed, false)
        }
        f.login()
        for (const id of ids) {
            f.query(true, shopFor(id, true))
            assert.equal(f.client.unlocked(id), false)
        }
    } finally {
        f.store.close()
    }
})

test('unlimited, wrong category, invalid histories and future cyclic prerequisites cannot be mistaken for sold-out stock', () => {
    const state = {
        player: { basic_info: { lv: 70 } },
        mall: { purchases: { 'diamond:20501': { period: 0, count: 100 } } },
    }
    for (const limit of [0, -1, -100]) {
        const fork = Object.create(tables)
        fork.get = (name) =>
            name === 'mall_goods'
                ? tables.get(name).map((row) => (row.goodsId === 20501 ? { ...row, goodsNum: limit } : row))
                : tables.get(name)
        const condition = mallConditions(fork, state, '12280#1#20501')
        assert(condition.supported && !condition.passed)
    }
    assert.throws(
        () => mallConditions(tables, state, '12280#1#20309'),
        (error) => error.code === ErrorCode.MallConfigError,
    )
    assert.throws(
        () => mallConditions(tables, state, '12280#2#20501'),
        (error) => error.code === ErrorCode.MallConfigError,
    )
    assert.throws(
        () =>
            mallConditions(
                tables,
                { ...state, mall: { purchases: { 'diamond:20501': { count: -1 } } } },
                '12280#1#20501',
            ),
        (error) => error.code === ErrorCode.MallConfigError,
    )
    const cyclic = Object.create(tables)
    cyclic.get = (name) =>
        name === 'mall_goods'
            ? tables.get(name).map((row) => (row.goodsId === 20501 ? { ...row, refreshType: 4 } : row))
            : tables.get(name)
    assert.equal(mallConditions(cyclic, state, '12280#1#20501').supported, false)
    const unknown = mallConditions(tables, state, '12083#255#500927#0#0')
    assert.equal(unknown.supported, false)
    assert.equal(unknown.passed, false)
})

test('actual codec and SQLite failures roll back reward, balance, purchase history and unlock state, and a clean retry pays once', () => {
    const f = fixture('rollback'),
        encode = protocol.encode.bind(protocol)
    try {
        const before = f.snapshot(),
            response = protocol.byName.get('CSProtoPlayerMallBuyPayGoods').rsp
        protocol.encode = (name, value) => {
            if (name === response) throw Error('mall ACK codec')
            return encode(name, value)
        }
        assert.throws(
            () => f.call('PlayerMallBuyPayGoods', { pay_shop_id: 305, pay_goods_id: 30501, buy_count: 1 }),
            /mall ACK codec/,
        )
        assert.deepEqual(f.snapshot(), before)
        protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER mall_condition_test BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'mall SQL rollback'); END",
        )
        assert.throws(
            () => f.call('PlayerMallBuyPayGoods', { pay_shop_id: 305, pay_goods_id: 30501, buy_count: 1 }),
            /mall SQL rollback/,
        )
        assert.deepEqual(f.snapshot(), before)
        f.store.db.exec('DROP TRIGGER mall_condition_test')
        const paid = currency(f.state())
        f.call('PlayerMallBuyPayGoods', { pay_shop_id: 305, pay_goods_id: 30501, buy_count: 1 })
        assert.equal(paid - currency(f.state()), BigInt(pay.get(30501).costPurchaseDiamondNum))
        assert.equal(f.state().mall.purchases['pay:30501'].count, 1)
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})
