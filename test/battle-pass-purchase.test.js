import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import { ErrorCode } from '../src/error-codes.js'
function fixture(
    name,
    { store = new Store(':memory:'), tables = new Tables(configuration().tables), offlinePayments = true } = {},
) {
    const protocol = new Protocol(configuration().base),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, offlinePayments }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const p = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: p.id, seq: seq++, payload: p.req ? protocol.encode(p.req, r) : Buffer.alloc(0) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: name })
    return { store, tables, protocol, game, session, call, state: () => store.load(session.id).state }
}
const order = (nonce, id, count = 1) => ({
    purchase_sdk_id: id,
    buy_count: count,
    product_id: 'lurukaps-offline:' + nonce + ':local-sku-metadata',
    amount: '0',
})
const quantity = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
test('offline battle pass SDK4001 unlocks premium, grants only immediate table reward and replays without real SDK invocation or duplicate goods', () => {
    const f = fixture('pass-pay-basic')
    try {
        const before = f.state().player.basic_info.diamond,
            packets = f.call('NonMallCreatePayOrder', order('battle-pass-basic-0001', 4001)),
            p = prepareBattlePass(f.tables, f.state(), 1800000000)
        assert.equal(p.ledger.pay_state, 1)
        assert.equal(p.ledger.level, 1)
        assert.equal(f.state().player.basic_info.diamond, before + 680)
        assert.deepEqual(p.ledger.paid, [])
        assert.equal(p.ledger.premiumOrders.length, 1)
        assert.equal(p.ledger.premiumOrders[0].sdk_item_id, 'battlepass_normal_1')
        const status = packets.find((x) => x.id === 18005).data,
            ntf = packets.find((x) => x.id === 18038).data
        assert.equal(status.pay_state, 1)
        assert.equal(ntf.purchase_sdk_id, 0)
        assert.equal(ntf.purchase_sdk_item, 'lurukaps-offline')
        assert.equal(ntf.callback_url, undefined)
        assert(packets.findIndex((x) => x.id === 18005) < packets.findIndex((x) => x.id === 18038))
        f.call('NonMallCreatePayOrder', order('battle-pass-basic-0001', 4001))
        assert.equal(f.state().player.basic_info.diamond, before + 680)
        assert.equal(f.state().mall.popupQueue.length, 1)
        const popup = f.call('GetRechargePopupData').find((p) => p.id === 18048).data
        assert.equal(popup.battlepass_data.rewards.src, 134)
        assert.equal(popup.battlepass_data.rewards.rewards[0].itemnum, 680)
        const paid = f.call('BattlePassGetLevelReward', { level: 1, is_paid: true }).find((p) => p.id === 18001).data
        assert(paid.rewards.length > 0)
    } finally {
        f.store.close()
    }
})
test('SDK4003 requires existing premium and upgrades it without regranting the initial680; SDK4002 grants the complete luxury package once', () => {
    for (const direct of [false, true]) {
        const f = fixture('pass-pay-luxury-' + direct)
        try {
            const before = f.state().player.basic_info.diamond,
                tickets = quantity(f.state(), 501000),
                items = quantity(f.state(), 100000)
            if (!direct) {
                assert.throws(
                    () => f.call('NonMallCreatePayOrder', order('battle-pass-no-base', 4003)),
                    (e) => e.code === ErrorCode.BattlePassNotPaid,
                )
                f.call('NonMallCreatePayOrder', order('battle-pass-pre-base', 4001))
            }
            f.call('NonMallCreatePayOrder', order('battle-pass-luxury-0001', direct ? 4002 : 4003))
            const p = prepareBattlePass(f.tables, f.state(), 1800000000)
            assert.equal(p.ledger.pay_state, 2)
            assert.equal(p.ledger.level, 11)
            assert.equal(p.ledger.curr_week_exp, 0)
            assert.equal(f.state().player.basic_info.diamond, before + 680)
            assert.equal(quantity(f.state(), 501000), tickets + 5)
            assert.equal(quantity(f.state(), 100000), items + 5)
            for (const id of [10158, 10223, 20102, 20207])
                assert(f.state().playerCardItems.some((x) => x.config === id))
            assert.deepEqual(p.ledger.paid, [])
            const stable = f.state()
            assert.throws(
                () => f.call('NonMallCreatePayOrder', order('battle-pass-repeat-0001', direct ? 4002 : 4003)),
                (e) => e.code === ErrorCode.BattlePassAlreadyPaid,
            )
            assert.deepEqual(f.state(), stable)
        } finally {
            f.store.close()
        }
    }
})
test('battle pass orders enforce single entitlement, refund, offline-disabled and expiration gates; luxury level bonus caps at the table maximum', () => {
    const f = fixture('pass-pay-gates')
    try {
        assert.throws(
            () => f.call('NonMallCreatePayOrder', order('battle-pass-count-0001', 4001, 2)),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.is_refund = true
        })
        assert.throws(
            () => f.call('NonMallCreatePayOrder', order('battle-pass-refund-0001', 4001)),
            (e) => e.code === ErrorCode.BattlePassRefund,
        )
        f.store.transact(f.session.id, 0, (s) => {
            const { ledger } = prepareBattlePass(f.tables, s, 1800000000)
            ledger.is_refund = false
            ledger.level = 65
        })
        const packets = f.call('NonMallCreatePayOrder', order('battle-pass-cap-0001', 4002))
        assert.equal(prepareBattlePass(f.tables, f.state(), 1800000000).ledger.level, 70)
        assert.equal(packets.find((p) => p.id === 18008).data.up_level, 5)
        f.game.clock = () => 2000000000
        assert.throws(
            () => f.call('NonMallCreatePayOrder', order('battle-pass-expired-0001', 4001)),
            (e) => e.code === ErrorCode.BattlePassNotFond,
        )
    } finally {
        f.store.close()
    }
    const disabled = fixture('pass-pay-disabled', { offlinePayments: false })
    try {
        assert.throws(
            () => disabled.call('NonMallCreatePayOrder', order('battle-pass-disabled-0001', 4001)),
            /disabled/,
        )
        assert.equal(disabled.state().mall?.localOrders, undefined)
    } finally {
        disabled.store.close()
    }
})
test('battle pass replay from an earlier start-key cannot unlock or level up a reused numeric season ID', () => {
    let f = fixture('pass-pay-season'),
        store = f.store
    try {
        const request = order('battle-pass-old-season', 4001)
        f.call('NonMallCreatePayOrder', request)
        const oldKey = f.state().battlePass.activeKey,
            diamonds = f.state().player.basic_info.diamond,
            tables = new Tables(configuration().tables)
        tables.cache.set(
            'battle_pass',
            tables.get('battle_pass').map((r) => ({ ...r, startTime: '20260701-040000' })),
        )
        f = fixture('pass-pay-season', { store, tables })
        assert.notEqual(f.state().battlePass.activeKey, oldKey)
        assert.equal(prepareBattlePass(tables, f.state(), 1800000000).ledger.pay_state, 0)
        const packets = f.call('NonMallCreatePayOrder', request)
        assert(!packets.some((p) => p.id === 18008))
        assert.equal(prepareBattlePass(tables, f.state(), 1800000000).ledger.pay_state, 0)
        assert.equal(f.state().player.basic_info.diamond, diamonds)
        f.call('NonMallCreatePayOrder', order('battle-pass-new-season', 4001))
        assert.equal(prepareBattlePass(tables, f.state(), 1800000000).ledger.pay_state, 1)
        assert.equal(f.state().player.basic_info.diamond, diamonds + 680)
        assert.equal(f.state().battlePass.seasons[oldKey].pay_state, 1)
    } finally {
        store.close()
    }
})
test('battle pass payment reply failure rolls back entitlement, immediate rewards, popup and order sequences', () => {
    const f = fixture('pass-pay-rollback')
    try {
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol),
            sequences = f.store.db.prepare('select * from sequences order by name').all()
        f.protocol.encode = (type, value) => {
            if (type === 'cs.SCBattlePassLevelExpPaySync') throw Error('pay codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('NonMallCreatePayOrder', order('battle-pass-bad-codec', 4002)), /pay codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.store.db.prepare('select * from sequences order by name').all(), sequences)
    } finally {
        f.store.close()
    }
})

test('battle pass paid tier and pending purchase popup survive SQLite restart and old order replay', () => {
    const parent = path.resolve(os.tmpdir()),
        temp = fs.mkdtempSync(path.join(parent, 'battle-pass-pay-persist-')),
        file = path.join(temp, 'state.sqlite')
    let f = fixture('pass-pay-persist', { store: new Store(file) })
    try {
        const request = order('battle-pass-persist-0001', 4002)
        f.call('NonMallCreatePayOrder', request)
        const before = f.state().player.basic_info.diamond,
            tickets = quantity(f.state(), 501000)
        f.store.close()
        f = fixture('pass-pay-persist', { store: new Store(file) })
        const p = prepareBattlePass(f.tables, f.state(), 1800000000)
        assert.equal(p.ledger.pay_state, 2)
        assert.equal(p.ledger.level, 11)
        assert.equal(p.ledger.premiumOrders.length, 1)
        f.call('NonMallCreatePayOrder', request)
        assert.equal(f.state().player.basic_info.diamond, before)
        assert.equal(quantity(f.state(), 501000), tickets)
        assert.equal(f.state().mall.popupQueue.length, 1)
        const data = f.call('GetRechargePopupData').find((p) => p.id === 18048).data
        assert.equal(data.battlepass_data.up_level, 10)
    } finally {
        f.store.close()
        const resolved = path.resolve(temp)
        if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('battle-pass-pay-persist-'))
            throw Error('Unexpected temporary cleanup target')
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
