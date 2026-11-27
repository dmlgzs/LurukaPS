import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { parseRewards } from '../src/rewards.js'
import { LOCAL_CALLBACK_NOTICE } from '../src/handlers/local-payments.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mallConditions } from '../src/mall-conditions.js'
import { ErrorCode } from '../src/error-codes.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'
import { ObtAppearanceConsumer } from './helpers/obt-appearance-consumer.js'
import { ObtClientModel } from './helpers/obt-client-model.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)

// Current MallParser06014093 / ShopStore0601c932,0601ca13,0601ca15.
// Records calls to the presentation layer; does not emulate Unity windows.
class MallConsumer {
    constructor(initialized = false) {
        this.initialized = initialized
        this.inventory = new ObtInventoryConsumer(tables, protocol)
        this.appearance = new ObtAppearanceConsumer(tables, protocol)
        this.assets = new ObtClientModel(tables, protocol)
        this.petSkins = new Set()
        this.dorm = new Set()
        this.queries = []
        this.presentations = []
        this.web = []
        this.sdkAttempts = 0
        this.orderMasksClosed = 0
    }
    show(rewards) {
        if (!rewards?.rewards?.length) return
        for (const reward of rewards.rewards) {
            if (reward.itemtype === 34)
                assert(this.appearance.unlockedClothes.has(reward.itemid), 'Clothing popup precedes ownership')
            if (reward.itemtype === 39) {
                const row = tables.get('hero_clothing').find((r) => r.clothingid === reward.itemid)
                assert(
                    row && this.appearance.skinOwnership.get(row.hero)?.has(reward.itemid),
                    'Hero skin popup precedes ownership',
                )
            }
            if (reward.itemtype === 37) assert(this.petSkins.has(reward.itemid), 'Pet skin popup precedes ownership')
            if (reward.itemtype === 40) assert(this.dorm.has(reward.itemid), 'Dorm style popup precedes ownership')
            if (reward.itemtype === 41)
                assert.equal(this.assets.assertVehicleReady(reward.guid).configId, reward.itemid)
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
            this.assets.consumePacket(packet)
            const kind = protocol.byId.get(packet.id).name
            if (
                [5001, 5008].includes(packet.id) ||
                ['SCProtoClothesInfoSync', 'SCProtoHeroSkinMessageSync'].includes(kind)
            )
                this.appearance.consume(packet)
            const entry = protocol.byId.get(packet.id),
                data = protocol.decode(entry.rsp, packet.payload)
            if (packet.id === 6549) for (const row of data.skin_infos ?? []) this.petSkins.add(row.skin_id)
            if (packet.id === 6102)
                for (const row of data.dorm?.back_ground_scene?.rewards ?? [])
                    if (row.itemnum > 0) this.dorm.add(row.itemid)
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

let identity = 0
const balance = (state, id) => BigInt(state.player.attr_infos.attrs.find((r) => r.attr_id === id)?.attr_val ?? 0)
function fixture(file = ':memory:', key = 'normal-pay-' + ++identity) {
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, offlinePayments: true })
    let session = {},
        client = new MallConsumer(true),
        seq = 1
    const call = (name, data = {}, consume = true) => {
        const entry = protocol.byName.get('CSProto' + name)
        const packets = game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: protocol.encode(entry.req, data),
        })
        if (consume) client.consume(packets)
        return packets
    }
    const login = () => {
        session = {}
        client = new MallConsumer(true)
        return call('EnterGame', { open_id: key })
    }
    login()
    const state = () => store.load(session.id).state
    const drain = () => {
        let requests = 0
        while (client.queries.length) {
            assert(++requests < 100, 'Actual success/popup callback chain did not terminate')
            call(client.queries.shift())
        }
        return requests
    }
    return { store, call, login, drain, state, id: () => session.id, client: () => client }
}
const rechargeOrder = (sdk, count, nonce) => ({
    purchase_sdk_id: sdk,
    buy_count: count,
    product_id: `lurukaps-offline:${nonce}:local`,
    amount: '0',
})
const payRows = new Map(tables.get('mall_pay_goods').map((r) => [r.goodsId, r]))
const shopFor = (id) =>
    tables.get('mall_shop').find((r) => String(r.goodsListPurchase).split('|').map(Number).includes(id)).shopId
const cashOrder = (id, count, nonce) => ({
    pay_shop_id: shopFor(id),
    pay_goods_id: id,
    buy_count: count,
    product_id: `lurukaps-offline:${nonce}:local`,
    amount: '0',
})
const decoded = (packets, id) =>
    packets.filter((p) => p.id === id).map((p) => protocol.decode(protocol.byId.get(id).rsp, p.payload))
const orderCount = (state) => Object.keys(state.mall?.localOrders ?? {}).length
const deepState = (f) => structuredClone(f.store.load(f.id()))

test('normal zero-paid-assets profile immediately consumes every current recharge tier, first and repeated bonuses, without SDK or relog', () => {
    const f = fixture()
    try {
        assert.equal(f.state().starterProfile.mode, 'normal')
        assert.equal(balance(f.state(), 901), 0n)
        assert.equal(balance(f.state(), 902), 0n)
        assert.equal(orderCount(f.state()), 0)
        const rows = tables.get('mall_recharge_diamond')
        assert.equal(rows.length, 6, 'exercise every recharge tier in the current target package')
        assert(rows.some((r) => r.rechargeDiamondNum === 6480))
        let paid = 0n,
            bonus = 0n,
            count = 0
        for (const row of rows) {
            for (const [attempt, quantity] of [
                [0, 1],
                [1, 2],
            ]) {
                const request = rechargeOrder(row.purchaseSdkID, quantity, `tier-${row.purchaseSdkID}-${attempt}`)
                const beforeShown = f.client().presentations.length
                const packets = f.call('NonMallCreatePayOrder', request)
                const receipts = decoded(packets, 18048)
                assert.equal(receipts.length, 1)
                assert.equal(receipts[0].recharge_diamond.purchase_sdk_id, row.purchaseSdkID)
                paid += BigInt(row.rechargeDiamondNum * quantity)
                bonus += BigInt(attempt ? row.rechargeBonus * quantity : row.firstRechargeBonus)
                const view = f.client().presentations.at(-1)
                assert.equal(f.client().presentations.length, beforeShown + 1)
                assert.equal(view.paid, paid)
                assert.equal(view.bonus, bonus)
                assert.equal(balance(f.state(), 901), paid)
                assert.equal(balance(f.state(), 902), bonus)
                assert(packets.findIndex((p) => p.id === 18043) < packets.findIndex((p) => p.id === 18048))
                assert.equal(decoded(packets, 18038)[0].errcode, LOCAL_CALLBACK_NOTICE)
                assert.equal(f.client().sdkAttempts, 0)
                assert.equal(f.state().mall.popupQueue.length, 0)
                f.drain()
                const state = deepState(f),
                    next = f.client().presentations.length
                f.call('NonMallCreatePayOrder', request)
                f.drain()
                assert.equal(f.client().presentations.length, next)
                assert.deepEqual(deepState(f).state, state.state)
                assert(deepState(f).revision >= state.revision)
                count++
            }
        }
        assert.equal(orderCount(f.state()), count)
        f.login()
        f.call('GetRechargePopupData')
        f.drain()
        assert.equal(f.client().presentations.length, 0)
        assert.equal(balance(f.state(), 901), paid)
        assert.equal(balance(f.state(), 902), bonus)
    } finally {
        f.store.close()
    }
})

test('every current cash gift is reachable from normal profile with real prerequisite purchases; receipts carry current configured rewards immediately', () => {
    assert.equal(payRows.size, 33, 'exercise the full current gift catalogue without an empty or partial loop')
    const visited = new Set()
    for (const row of payRows.values()) {
        const f = fixture()
        try {
            assert.equal(balance(f.state(), 901), 0n)
            assert.equal(balance(f.state(), 902), 0n)
            const unlock = (target, seen = new Set()) => {
                assert(!seen.has(target.goodsId), 'Current cash prerequisite graph cycles')
                seen.add(target.goodsId)
                for (const token of String(target.commonCondition).split('|').filter(Boolean)) {
                    const [kind, type, id] = token.split('#').map(Number)
                    if (kind !== 12280) continue
                    assert.equal(type, 2)
                    const prerequisite = payRows.get(id)
                    assert(prerequisite)
                    unlock(prerequisite, seen)
                    const old = f.state().mall?.purchases?.['pay:' + id]?.count ?? 0
                    const remaining = prerequisite.goodsNum - old
                    if (remaining > 0) {
                        f.call('PlayerMallCreatePayOrder', cashOrder(id, remaining, `pre-${row.goodsId}-${id}`))
                        f.drain()
                    }
                }
                seen.delete(target.goodsId)
            }
            unlock(row)
            const condition = mallConditions(tables, f.state(), row.commonCondition)
            assert(condition.supported && condition.passed, `Current gift ${row.goodsId} lacks reachable prerequisite`)
            const before = f.client().presentations.length
            const packets = f.call('PlayerMallCreatePayOrder', cashOrder(row.goodsId, 1, `cash-row-${row.goodsId}`))
            const receipt = decoded(packets, 18048)[0]
            assert.equal(receipt.mall_data.pay_goods_id, row.goodsId)
            assert.equal(f.client().presentations.length, before + 1)
            const actual = receipt.mall_data.pay_rewards.rewards
            for (const expected of parseRewards(row.item))
                assert(
                    actual.some(
                        (r) =>
                            r.itemtype === expected.itemtype &&
                            r.itemid === expected.itemid &&
                            r.itemnum === expected.itemnum,
                    ),
                )
            for (const reward of actual.filter((r) => r.itemtype === 3))
                assert(f.client().inventory.count(reward.itemid) >= reward.itemnum)
            assert.equal(decoded(packets, 18035)[0].errcode, LOCAL_CALLBACK_NOTICE)
            assert(packets.findIndex((p) => p.id === 18036) < packets.findIndex((p) => p.id === 18048))
            assert.equal(f.client().sdkAttempts, 0)
            f.drain()
            assert.equal(f.state().mall.popupQueue.length, 0)
            visited.add(row.goodsId)
        } finally {
            f.store.close()
        }
    }
    assert.deepEqual(visited, new Set(payRows.keys()))
})

test('real multi-order receipts drain FIFO across replay and SQLite reopen without regrant; popup codec and SQL failures roll back all delivery state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-mall-receipts-'))
    const file = path.join(dir, 'state.sqlite'),
        key = 'receipt-reopen'
    let f = fixture(file, key)
    const encode = protocol.encode.bind(protocol)
    try {
        const first = cashOrder(20101, 1, 'queue-cash-001')
        const second = rechargeOrder(2006, 1, 'queue-recharge-001')
        const raw = [f.call('PlayerMallCreatePayOrder', first, false), f.call('NonMallCreatePayOrder', second, false)]
        const receipts = raw.flatMap((packets) => decoded(packets, 18048))
        // Explicit, controlled unsent-presentation backlog of already fulfilled
        // orders; does not claim a network-loss ACK or grant rewards again.
        for (const packets of raw) f.client().consume(packets.filter((p) => p.id !== 18048))
        f.store.transact(f.id(), 0, (state) => {
            state.mall.popupQueue = structuredClone(receipts)
        })
        const produced = [cashOrder(20102, 1, 'queue-cash-002'), rechargeOrder(2001, 1, 'queue-recharge-002')]
        const sent = [f.call('PlayerMallCreatePayOrder', produced[0]), f.call('NonMallCreatePayOrder', produced[1])]
        assert.deepEqual(
            sent.flatMap((ps) => decoded(ps, 18048)).map((r) => r.popup_id),
            receipts.map((r) => r.popup_id),
        )
        assert.equal(f.state().mall.popupQueue.length, 2)
        assert.equal(orderCount(f.state()), 4)
        const assets = structuredClone(f.state().player),
            pending = structuredClone(f.state().mall.popupQueue)
        f.store.close()
        f = fixture(file, key)
        assert.equal(f.client().presentations.length, 0)
        const replay = f.call('PlayerMallCreatePayOrder', produced[0])
        assert.equal(decoded(replay, 18048)[0].popup_id, pending[0].popup_id)
        assert.equal(orderCount(f.state()), 4)
        f.drain()
        assert.equal(f.client().presentations.length, 2)
        assert.deepEqual(f.state().player, assets)
        assert.equal(f.state().mall.popupQueue.length, 0)
        const next = rechargeOrder(2006, 1, 'codec-recharge-002')
        const before = deepState(f),
            sequences = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
        protocol.encode = (name, data) => {
            if (name === protocol.byId.get(18048).rsp) throw Error('current mall popup codec')
            return encode(name, data)
        }
        assert.throws(() => f.call('NonMallCreatePayOrder', next), /current mall popup codec/)
        protocol.encode = encode
        assert.deepEqual(deepState(f), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), sequences)
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_mall_delivery BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'current mall SQL failure'); END",
        )
        assert.throws(() => f.call('NonMallCreatePayOrder', next), /current mall SQL failure/)
        f.store.db.exec('DROP TRIGGER reject_mall_delivery')
        assert.deepEqual(deepState(f), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), sequences)
        assert.equal(decoded(f.call('NonMallCreatePayOrder', next), 18048).length, 1)
        f.drain()
        const settled = deepState(f),
            shown = f.client().presentations.length
        f.call('NonMallCreatePayOrder', next)
        f.drain()
        assert.equal(f.client().presentations.length, shown)
        assert.deepEqual(deepState(f).state, settled.state)
        assert(deepState(f).revision >= settled.revision)
    } finally {
        protocol.encode = encode
        f.store.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('every current diamond-priced cash gift uses a real6480 recharge wallet, dedicated ownership before18033, and correct static rejection on second buy', () => {
    const rows = [...payRows.values()].filter((r) => r.costPurchaseDiamondNum > 0)
    assert.equal(rows.length, 15, 'exercise every current diamond-priced product')
    for (const row of rows) {
        const f = fixture()
        try {
            assert.equal(balance(f.state(), 901), 0n)
            assert.equal(balance(f.state(), 902), 0n)
            const recharge = tables.get('mall_recharge_diamond').find((r) => r.rechargeDiamondNum === 6480)
            f.call('NonMallCreatePayOrder', rechargeOrder(recharge.purchaseSdkID, 1, `diamond-fund-${row.goodsId}`))
            f.drain()
            const paid = balance(f.state(), 901),
                bonus = balance(f.state(), 902)
            assert(paid + bonus >= BigInt(row.costPurchaseDiamondNum))
            const shown = f.client().presentations.length
            const request = { pay_shop_id: shopFor(row.goodsId), pay_goods_id: row.goodsId, buy_count: 1 }
            const packets = f.call('PlayerMallBuyPayGoods', request)
            assert.equal(f.client().presentations.length, shown + 1)
            const ack = decoded(packets, 18033)[0]
            assert.equal(ack.pay_goods.goods_id, row.goodsId)
            assert.equal(ack.pay_goods.curr_purchase_num, 1)
            for (const reward of parseRewards(row.item))
                assert(
                    ack.pay_rewards.rewards.some(
                        (r) =>
                            r.itemtype === reward.itemtype &&
                            r.itemid === reward.itemid &&
                            r.itemnum === reward.itemnum,
                    ),
                )
            const cost = BigInt(row.costPurchaseDiamondNum),
                bonusSpent = bonus < cost ? bonus : cost
            assert.equal(balance(f.state(), 902), bonus - bonusSpent)
            assert.equal(balance(f.state(), 901), paid - (cost - bonusSpent))
            assert.equal(orderCount(f.state()), 1, 'The diamond gift must not create another cash order')
            assert.equal(
                packets.some((p) => p.id === 18048),
                false,
            )
            assert.equal(f.client().sdkAttempts, 0)
            const before = deepState(f)
            assert.throws(
                () => f.call('PlayerMallBuyPayGoods', request),
                (e) => e.code === ErrorCode.MallGoodsStaticCondInvalid,
            )
            assert.deepEqual(deepState(f), before)
        } finally {
            f.store.close()
        }
    }
})
