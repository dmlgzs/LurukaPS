import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
const order = (nonce, id = 2001, count = 1) => ({
    purchase_sdk_id: id,
    buy_count: count,
    product_id: `lurukaps-offline:${nonce}:local-test-product`,
    amount: '0',
})
function fixture(options = {}, filename = ':memory:') {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { offlinePayments: true, ...options }),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: 55, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'offline-pay' })
    return { store, session, call, state: () => store.load(session.id).state }
}
const currency = (s, id) => Number(s.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? 0)
test('offline recharge grants correct currency and first bonus once, with non-actionable SDK notice', () => {
    const f = fixture()
    try {
        const packets = f.call('NonMallCreatePayOrder', order('nonce-0001', 2002, 2))
        assert.equal(currency(f.state(), 901), 600)
        assert.equal(currency(f.state(), 902), 350)
        assert.equal(f.state().player.basic_info.gold, 0)
        assert.equal(f.state().player.basic_info.diamond, 0)
        const notice = packets.find((p) => p.id === 18038).data
        assert.equal(notice.purchase_sdk_id, 0)
        assert.equal(notice.purchase_sdk_item, 'lurukaps-offline')
        assert.equal(notice.callback_url, undefined)
        const syncIndex = packets.findIndex((p) => p.id === protocol.byName.get('CSProtoSyncPlayerData').id)
        assert(syncIndex >= 0 && syncIndex < packets.findIndex((p) => p.id === 18038))
        f.call('NonMallCreatePayOrder', order('nonce-0001', 2002, 2))
        // Older clients use the previous project prefix; nonce remains idempotent.
        const legacy = order('nonce-0001', 2002, 2)
        legacy.product_id = legacy.product_id.replace('lurukaps-offline:', 'azurjs-offline:')
        f.call('NonMallCreatePayOrder', legacy)
        assert.equal(currency(f.state(), 901), 600)
        assert.equal(f.state().mall.popupQueue.length, 0)
        assert(packets.some((p) => p.id === 18048 && p.data.recharge_diamond))
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('NonMallCreatePayOrder', order('nonce-0001', 2002, 3)), /nonce reused/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.call('NonMallCreatePayOrder', order('nonce-0002', 2002, 1))
        assert.equal(currency(f.state(), 901), 900)
        assert.equal(currency(f.state(), 902), 400)
    } finally {
        f.store.close()
    }
})
test('disabled and unknown-product orders never grant or reserve IDs', () => {
    for (const options of [{}, { offlinePayments: false }]) {
        const f = fixture(options)
        try {
            const before = f.store.load(f.session.id)
            if (options.offlinePayments === false)
                assert.throws(() =>
                    f.call('NonMallCreatePayOrder', { ...order('nonce-0003'), product_id: 'diamond_1' }),
                )
            else
                assert.throws(() =>
                    f.call('NonMallCreatePayOrder', { ...order('nonce-0003', 999999), product_id: 'unknown' }),
                )
            if (!options.offlinePayments && options.offlinePayments !== undefined)
                assert.throws(() => f.call('NonMallCreatePayOrder', order('nonce-0004')), /disabled/)
            else assert.throws(() => f.call('NonMallCreatePayOrder', order('nonce-0004', 999999)))
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.equal(f.store.db.prepare("SELECT count(*) n FROM sequences WHERE name LIKE 'offline-%'").get().n, 0)
        } finally {
            f.store.close()
        }
    }
})
test('offline gift follows catalog stock limits and all failures roll back', () => {
    const f = fixture()
    try {
        const packets = f.call('NonMallCreatePayOrder', order('gift-0001', 3002))
        assert(packets.some((p) => p.id === 18036))
        assert.equal(f.state().mall.purchases['pay:20101'].count, 1)
        assert.equal(f.state().player.basic_info.gold, 60000)
        const before = f.store.load(f.session.id),
            counter = f.store.db.prepare("SELECT value FROM sequences WHERE name='offline-order'").get().value
        assert.throws(() => f.call('NonMallCreatePayOrder', order('gift-0002', 3002)), /purchase limit/)
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.equal(f.store.db.prepare("SELECT value FROM sequences WHERE name='offline-order'").get().value, counter)
    } finally {
        f.store.close()
    }
})
test('order deduplication and consumed delivery popups survive database restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azur-orders-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture({}, file)
    try {
        const delivered = f.call('NonMallCreatePayOrder', order('persist-0001'))
        f.store.close()
        f = fixture({}, file)
        f.call('NonMallCreatePayOrder', order('persist-0001'))
        assert.equal(currency(f.state(), 901), 60)
        const popup = delivered.find((p) => p.id === 18048).data
        assert(popup.popup_id > 0)
        assert.equal(popup.recharge_diamond.purchase_sdk_id, 2001)
        assert.equal(f.call('GetRechargePopupData')[0].data.popup_id, 0)
        assert.equal(f.call('PlayerMallGetRechargeDiamond')[0].data.purchase_sdk_id_list[0], 2001)
    } finally {
        f.store.close()
        assert(dir.startsWith(path.join(os.tmpdir(), 'azur-orders-')))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('mall orders validate shop membership and return the correct async channel', () => {
    const f = fixture()
    try {
        const request = {
            pay_shop_id: 201,
            pay_goods_id: 20101,
            buy_count: 1,
            product_id: 'lurukaps-offline:mall-0001:gift',
            amount: '0',
        }
        const output = f.call('PlayerMallCreatePayOrder', request)
        const notice = output.find((p) => p.id === 18035)
        assert(notice)
        assert.equal(notice.data.pay_shop_id, 201)
        assert.equal(notice.data.pay_goods_id, 20101)
        assert.equal(notice.data.purchase_sdk_id, 0)
        assert(!output.some((p) => p.id === 18038 || p.id === 18039))
        assert(output.some((p) => p.id === 18036))
        assert.equal(f.state().player.basic_info.gold, 60000)
        f.call('PlayerMallCreatePayOrder', request)
        assert.equal(f.state().player.basic_info.gold, 60000)
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('PlayerMallCreatePayOrder', { ...request, pay_shop_id: 203 }))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})
