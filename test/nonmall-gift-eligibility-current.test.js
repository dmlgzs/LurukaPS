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
import { ErrorCode, LocalErrorCode } from '../src/error-codes.js'
import { parseRewards } from '../src/rewards.js'
import { battlePassPurchaseMode } from '../src/battle-pass-purchase.js'

const config = configuration(),
    tables = new Tables(config.tables),
    pay = tables.get('mall_pay_goods')
const shopFor = (id) =>
    tables.get('mall_shop').find((s) => String(s.goodsListPurchase).split('|').map(Number).includes(id)).shopId
const unique = (row) => pay.filter((r) => r.purchaseSdkID === row.purchaseSdkID).length === 1
const chained = pay.filter(
    (r) =>
        unique(r) &&
        String(r.commonCondition)
            .split('|')
            .some((s) => s.startsWith('12280#2#')),
)
const cosmetic = pay.find((r) => unique(r) && String(r.commonCondition).startsWith('12083#37#'))
const plain = pay.find((r) => unique(r) && !r.commonCondition && r.goodsNum === 1)
let number = 0
function fixture(file = ':memory:', account = 'nonmall-gift-' + ++number) {
    const protocol = new Protocol(config.base),
        store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, offlinePayments: true }),
        session = {}
    let seq = 1
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
    }
    call('EnterGame', { open_id: account })
    const raw = () => structuredClone(store.load(session.id))
    const snapshots = () => ({
        saved: raw(),
        sql: store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
        sequences: store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
        requests: store.db.prepare('SELECT * FROM request_log ORDER BY id').all(),
        cacheToken: store.readCacheToken(session.id),
    })
    const order = (row, nonce, count = 1) => ({
        purchase_sdk_id: row.purchaseSdkID,
        buy_count: count,
        product_id: `lurukaps-offline:${nonce}:local`,
        amount: '0',
    })
    const nonmall = (row, nonce, count = 1) => call('NonMallCreatePayOrder', order(row, nonce, count))
    const mall = (row, nonce, count = 1) =>
        call('PlayerMallCreatePayOrder', {
            pay_shop_id: shopFor(row.goodsId),
            pay_goods_id: row.goodsId,
            buy_count: count,
            product_id: `lurukaps-offline:${nonce}:local`,
            amount: '0',
        })
    const denied = (fn, code) => {
        const before = snapshots()
        assert.throws(fn, (e) => e.code === code)
        assert.deepEqual(snapshots(), before)
    }
    return {
        protocol,
        store,
        game,
        call,
        raw,
        snapshots,
        order,
        nonmall,
        mall,
        denied,
        state: () => store.load(session.id).state,
    }
}
function fulfillPrerequisites(f, row, pending = new Set()) {
    assert(!pending.has(row.goodsId), 'current prerequisite cycle')
    pending.add(row.goodsId)
    for (const token of String(row.commonCondition).split('|')) {
        const [kind, type, id] = token.split('#').map(Number)
        if (kind !== 12280) continue
        assert.equal(type, 2)
        const previous = pay.find((r) => r.goodsId === id)
        assert(previous)
        fulfillPrerequisites(f, previous, pending)
        const count = previous.goodsNum - (f.state().mall?.purchases?.['pay:' + id]?.count ?? 0)
        if (count > 0) f.mall(previous, 'prerequisite-' + row.goodsId + '-' + id, count)
    }
    pending.delete(row.goodsId)
}
const packet = (f, ps, id) => {
    const p = ps.find((p) => p.id === id)
    return p && f.protocol.decode(f.protocol.byId.get(id).rsp, p.payload)
}

test('registered NonMall gift API rejects current unearned prerequisites, independently owned entitlement and exhausted quota with the same precise purchase errors and zero failed writes', () => {
    assert(chained.length > 0 && cosmetic && plain)
    for (const row of chained) {
        const f = fixture()
        try {
            f.denied(() => f.mall(row, 'locked-mall-' + row.goodsId), ErrorCode.MallGoodsStaticCondInvalid)
            f.denied(() => f.nonmall(row, 'locked-compatible-' + row.goodsId), ErrorCode.MallGoodsStaticCondInvalid)
        } finally {
            f.store.close()
        }
    }
    const f = fixture()
    try {
        const [kind, type, id] = String(cosmetic.commonCondition).split('#').map(Number)
        assert.equal(kind, 12083)
        assert.equal(type, 37)
        f.call('GMCommand', { command: Buffer.from(`give ${type} ${id} 1`).toString('base64') })
        assert.equal(f.state().mall?.purchases?.['pay:' + cosmetic.goodsId], undefined)
        f.denied(() => f.mall(cosmetic, 'owned-mall-endpoint'), ErrorCode.MallGoodsStaticCondInvalid)
        f.denied(() => f.nonmall(cosmetic, 'owned-compatible-endpoint'), ErrorCode.MallGoodsStaticCondInvalid)
    } finally {
        f.store.close()
    }
    const q = fixture()
    try {
        q.nonmall(plain, 'one-lifetime-gift')
        q.denied(() => q.mall(plain, 'full-mall-endpoint'), ErrorCode.MallGoodsNumLimit)
        q.denied(() => q.nonmall(plain, 'full-compatible-endpoint'), ErrorCode.MallGoodsNumLimit)
    } finally {
        q.store.close()
    }
})

test('the same current prerequisites admit real compatible delivery, while a fulfilled receipt replays after ownership or quota changes without regrant or popup duplication', () => {
    for (const row of chained) {
        const f = fixture()
        try {
            fulfillPrerequisites(f, row)
            const ps = f.nonmall(row, 'qualified-compatible-' + row.goodsId),
                popup = packet(f, ps, 18048)
            assert.equal(popup.mall_data.pay_goods_id, row.goodsId)
            for (const reward of parseRewards(row.item))
                assert(
                    popup.mall_data.pay_rewards.rewards.some(
                        (r) =>
                            r.itemtype === reward.itemtype &&
                            r.itemid === reward.itemid &&
                            r.itemnum === reward.itemnum,
                    ),
                )
            assert.equal(packet(f, ps, 18038).errcode, LocalErrorCode.OfflinePaymentCallback)
            assert(ps.findIndex((p) => p.id === 5008) < ps.findIndex((p) => p.id === 18048))
            const before = f.raw().state,
                sequences = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
            const replay = f.nonmall(row, 'qualified-compatible-' + row.goodsId)
            assert(!replay.some((p) => p.id === 18048))
            assert.deepEqual(f.state(), before)
            assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), sequences)
        } finally {
            f.store.close()
        }
    }
    const f = fixture()
    try {
        f.nonmall(cosmetic, 'real-compatible-cosmetic')
        const before = f.raw().state,
            sequences = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
        f.denied(() => f.nonmall(cosmetic, 'new-owned-cosmetic'), ErrorCode.MallGoodsStaticCondInvalid)
        const replay = f.nonmall(cosmetic, 'real-compatible-cosmetic')
        assert(!replay.some((p) => p.id === 18048))
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), sequences)
    } finally {
        f.store.close()
    }
})

test('compatible gift delivery codecs and SQL roll back complete state, popup, request and identity ledgers; same nonce retries once and persists across cold SQLite reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonmall-gift-plan-')),
        file = path.join(dir, 'synthetic.sqlite'),
        account = 'nonmall-gift-reopen'
    let f = fixture(file, account)
    const originalEncode = f.protocol.encode.bind(f.protocol)
    try {
        const before = f.snapshots(),
            request = f.order(plain, 'atomic-compatible-gift')
        f.protocol.encode = (name, data) => {
            if (name === f.protocol.byId.get(18048).rsp) throw Error('compatible gift codec')
            return originalEncode(name, data)
        }
        assert.throws(() => f.call('NonMallCreatePayOrder', request), /compatible gift codec/)
        f.protocol.encode = originalEncode
        assert.deepEqual(f.snapshots(), before)
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_compatible BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'compatible gift SQL'); END",
        )
        assert.throws(() => f.call('NonMallCreatePayOrder', request), /compatible gift SQL/)
        f.store.db.exec('DROP TRIGGER reject_compatible')
        assert.deepEqual(f.snapshots(), before)
        assert(packet(f, f.call('NonMallCreatePayOrder', request), 18048))
        const state = f.raw().state,
            seq = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
        f.store.close()
        f = fixture(file, account)
        const replay = f.call('NonMallCreatePayOrder', request)
        assert(!replay.some((p) => p.id === 18048))
        const reopened = f.raw().state
        assert.match(reopened.worldObjectAoi.connection_hash, /^[a-f0-9]{64}$/)
        assert.notEqual(reopened.worldObjectAoi.connection_hash, state.worldObjectAoi.connection_hash)
        const expected = structuredClone(state)
        // Current resetWorldObjectAoiSession intentionally rotates only this
        // connection identity here (the fixture has no active object leases).
        expected.worldObjectAoi.connection_hash = reopened.worldObjectAoi.connection_hash
        assert.deepEqual(reopened, expected)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), seq)
        assert.equal(Object.keys(f.state().mall.localOrders).length, 1)
    } finally {
        f.protocol.encode = originalEncode
        f.store.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('current recharge, table-defined monthly bonus and both battle-pass product modes keep their non-gift receipt branches and idempotency', () => {
    const recharge = tables.get('mall_recharge_diamond').find((r) => r.rechargeDiamondNum === 6480)
    const monthly = tables.get('monthly_card').find((r) => r.id === r.purchaseSdkID) ?? tables.get('monthly_card')[0]
    const battle = tables
        .get('purchase_sdk')
        .filter((r) => ['advanced', 'luxury'].includes(battlePassPurchaseMode(tables, r.id)))
    assert(recharge && monthly && battle.length === 2)
    const inputs = [
        { sdk: recharge.purchaseSdkID, key: 'recharge', popup: 'recharge_diamond', count: 1 },
        { sdk: monthly.purchaseSdkID, key: 'monthly', popup: 'monthly_card_data', count: 2 },
        ...battle.map((r) => ({ sdk: r.id, key: 'battlepass', popup: 'battlepass_data', count: 1 })),
    ]
    for (const row of inputs) {
        const f = fixture()
        try {
            const request = {
                purchase_sdk_id: row.sdk,
                buy_count: row.count,
                product_id: `lurukaps-offline:special-branch-${row.sdk}:local`,
                amount: '0',
            }
            const ps = f.call('NonMallCreatePayOrder', request),
                popup = packet(f, ps, 18048)
            assert(popup[row.popup])
            assert.equal(popup.mall_data, undefined)
            const order = Object.values(f.state().mall.localOrders)[0]
            assert(order[row.key])
            assert.equal(order.gift, undefined)
            assert.equal(packet(f, ps, 18038).errcode, LocalErrorCode.OfflinePaymentCallback)
            if (row.key === 'monthly') {
                assert.equal(f.state().monthlyCard.end_time, 1800000000 + monthly.day * row.count * 86400)
                for (const reward of parseRewards(monthly.reward)) {
                    assert.equal(reward.itemtype, 10)
                    const amount = BigInt(
                        f.state().player.attr_infos.attrs.find((a) => a.attr_id === reward.itemid)?.attr_val ?? 0,
                    )
                    assert.equal(amount, BigInt(reward.itemnum * row.count))
                }
            }
            const before = f.raw().state,
                seq = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
            assert(!f.call('NonMallCreatePayOrder', request).some((p) => p.id === 18048))
            assert.deepEqual(f.state(), before)
            assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), seq)
        } finally {
            f.store.close()
        }
    }
})
