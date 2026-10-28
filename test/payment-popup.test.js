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
import { decodeFrame, encodeFrame } from '../src/wire.js'
const config = configuration(),
    tables = new Tables(config.tables)
const recharge = { purchase_sdk_id: 2006, buy_count: 1, product_id: 'lurukaps-offline:popup-6480:local', amount: '0' }
const gift = {
    pay_shop_id: 201,
    pay_goods_id: 20101,
    buy_count: 1,
    product_id: 'lurukaps-offline:popup-gift:local',
    amount: '0',
}
function fixture(file = ':memory:') {
    const protocol = new Protocol(config.base),
        store = new Store(file),
        game = new Game(protocol, store, tables, { offlinePayments: true }),
        session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((p) => ({ ...p, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'payment-popup' })
    return { protocol, store, session, call, state: () => store.load(session.id).state }
}
const popup = (packets) => packets.filter((p) => p.id === 18048)
test('online6480 and mall gift start the real18048 consumer after wallet and delivery notifications, without waiting for a query', () => {
    for (const [name, request, success, field] of [
        ['NonMallCreatePayOrder', recharge, 18039, 'recharge_diamond'],
        ['PlayerMallCreatePayOrder', gift, 18036, 'mall_data'],
    ]) {
        const f = fixture()
        try {
            const packets = f.call(name, request),
                shown = popup(packets)
            assert.equal(shown.length, 1)
            assert(shown[0].data[field])
            assert.equal(shown[0].seq ?? 0, 0)
            const frame = decodeFrame(encodeFrame(shown[0], shown[0].payload))
            assert.equal(frame.seq, 0)
            assert.equal(frame.id, 18048)
            assert.deepEqual(f.protocol.decode(f.protocol.byId.get(18048).rsp, frame.payload), shown[0].data)
            assert(packets.findIndex((p) => p.id === success) < packets.findIndex((p) => p.id === 18048))
            assert(
                packets.findIndex((p) => p.id === f.protocol.byName.get('CSProtoSyncPlayerData').id) <
                    packets.findIndex((p) => p.id === 18048),
            )
            assert.equal(f.state().mall.popupQueue.length, 0)
            assert.equal(popup(f.call('GetRechargePopupData'))[0].data.popup_id, 0)
            assert.equal(popup(f.call(name, request)).length, 0)
            assert.equal(Object.values(f.state().mall.localOrders).length, 1)
            if (name === 'NonMallCreatePayOrder') {
                const rewards = shown[0].data.recharge_diamond
                const row = tables.get('mall_recharge_diamond').find((r) => r.purchaseSdkID === 2006)
                assert.equal(rewards.recharge_diamond_num, row.rechargeDiamondNum)
                assert.equal(rewards.first_recharge_bonus, row.firstRechargeBonus)
            }
        } finally {
            f.store.close()
        }
    }
})
test('public18048 and the initialized client success-notification query drain each queued receipt once and terminate both chains', () => {
    const f = fixture()
    try {
        const old = [71, 72].map((id) => ({
            popup_id: id,
            pay_source: 0,
            purchase_sdk_id: 2006,
            monthly_card_data: { rewards: { rewards: [{ itemtype: 10, itemid: 1, itemnum: id }] } },
        }))
        f.store.transact(f.session.id, 0, (s) => {
            s.mall = { popupQueue: old }
        })
        const packets = f.call('NonMallCreatePayOrder', recharge)
        // When m_isMallFirstReq=true, 18039 schedules a query while the unsolicited
        // 18048 also schedules one. Socket requests remain serialized by Game.
        const shown = popup(packets).map((p) => p.data.popup_id),
            requests = ['success', 'push']
        let empty = 0,
            steps = 0
        while (requests.length) {
            requests.shift()
            const data = popup(f.call('GetRechargePopupData'))[0].data
            if (data.monthly_card_data || data.recharge_diamond || data.mall_data) {
                shown.push(data.popup_id)
                requests.push('continue')
            } else {
                assert.equal(data.popup_id, 0)
                empty++
            }
            assert(++steps < 10)
        }
        assert.deepEqual(shown.slice(0, 2), [71, 72])
        assert.equal(shown.length, 3)
        assert.equal(new Set(shown).size, 3)
        assert.equal(empty, 2)
        assert.deepEqual(f.state().mall.popupQueue, [])
    } finally {
        f.store.close()
    }
})
test('18048 encoding failure restores the full order, wallet, queue and identities before same request retry', () => {
    const f = fixture(),
        encode = f.protocol.encode.bind(f.protocol)
    try {
        const before = f.store.load(f.session.id),
            counters = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
        f.protocol.encode = (name, data) => {
            if (name === f.protocol.byId.get(18048).rsp) throw Error('popup codec failure')
            return encode(name, data)
        }
        assert.throws(() => f.call('NonMallCreatePayOrder', recharge), /popup codec failure/)
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), counters)
        f.protocol.encode = encode
        assert.equal(popup(f.call('NonMallCreatePayOrder', recharge)).length, 1)
        assert.equal(popup(f.call('NonMallCreatePayOrder', recharge)).length, 0)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
test('SQLite restart keeps delivered presentation consumed and pending older receipts available without regranting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-popup-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture(file)
    try {
        assert.equal(popup(f.call('NonMallCreatePayOrder', recharge)).length, 1)
        const attrs = structuredClone(f.state().player.attr_infos)
        f.store.close()
        f = fixture(file)
        assert.equal(popup(f.call('GetRechargePopupData'))[0].data.popup_id, 0)
        assert.equal(popup(f.call('NonMallCreatePayOrder', recharge)).length, 0)
        assert.deepEqual(f.state().player.attr_infos, attrs)
        f.store.transact(f.session.id, 0, (s) => {
            s.mall.popupQueue.push({ popup_id: 990, pay_source: 0, recharge_diamond: { purchase_sdk_id: 2006 } })
        })
        f.store.close()
        f = fixture(file)
        assert.equal(popup(f.call('GetRechargePopupData'))[0].data.popup_id, 990)
        assert.equal(popup(f.call('GetRechargePopupData'))[0].data.popup_id, 0)
    } finally {
        f.store.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
