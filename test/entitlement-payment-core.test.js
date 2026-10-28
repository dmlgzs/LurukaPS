import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { prepareBattlePass } from '../src/battle-pass.js'

function fixture() {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (sdk, nonce = 'core-payment-0001', count = 1) => {
        const e = protocol.byName.get('CSProtoNonMallCreatePayOrder')
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: protocol.encode(e.req, {
                purchase_sdk_id: sdk,
                buy_count: count,
                product_id: 'lurukaps-offline:' + nonce + ':real-local-product',
                amount: '0',
            }),
        })
    }
    const e = protocol.byName.get('CSProtoEnterGame')
    game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, { open_id: 'entitlement-core' }) })
    return { tables, protocol, store, session, call, state: () => store.load(session.id).state }
}

test('pure benefit extraction leaves real18037 monthly and luxury order provenance and nonce delivery unchanged', () => {
    const f = fixture()
    try {
        f.call(5001, 'core-monthly-0001', 2)
        let s = f.state(),
            orders = Object.values(s.mall.localOrders)
        assert.equal(orders.length, 1)
        assert.equal(orders[0].purchase_sdk_id, 5001)
        assert.equal(orders[0].count, 2)
        assert.equal(orders[0].mode, 'offline-simulated')
        assert.equal(s.monthlyCard.end_time, 1800000000 + 60 * 86400)
        assert.equal(s.player.attr_infos.attrs.find((a) => a.attr_id === 901).attr_val, '600')
        f.call(4002, 'core-luxury-0001')
        s = f.state()
        orders = Object.values(s.mall.localOrders)
        const paid = orders.find((o) => o.purchase_sdk_id === 4002),
            p = prepareBattlePass(f.tables, s, 1800000000)
        assert.equal(orders.length, 2)
        assert.deepEqual(p.ledger.premiumOrders, [
            {
                order_id: paid.id,
                purchase_sdk_id: 4002,
                sdk_item_id: 'battlepass_advanced_1',
                time: 1800000000,
                mode: 'luxury',
            },
        ])
        assert.equal(p.ledger.pay_state, 2)
        assert.equal(paid.battlepass.data.up_level, 10)
        const before = structuredClone(s)
        f.call(5001, 'core-monthly-0001', 2)
        f.call(4002, 'core-luxury-0001')
        assert.deepEqual(f.state(), before)
        assert.equal(s.entitlementTickets, undefined)
    } finally {
        f.store.close()
    }
})

test('real18037 benefit and order updates both roll back on presentation codec and late SQL failures', () => {
    for (const sdk of [5001, 4002]) {
        const f = fixture(),
            encode = f.protocol.encode
        try {
            const before = f.store.load(f.session.id),
                sql = () =>
                    f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                saved = sql()
            const counters = () => f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
                initialCounters = counters()
            f.protocol.encode = function (name, ...args) {
                if (name === f.protocol.byId.get(18048).rsp) throw Error('core-presentation-codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call(sdk), /core-presentation-codec/)
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.deepEqual(sql(), saved)
            assert.deepEqual(counters(), initialCounters)
            f.protocol.encode = encode
            f.store.db.exec(
                "CREATE TEMP TRIGGER core_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'core-sql'); END",
            )
            assert.throws(() => f.call(sdk), /core-sql/)
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.deepEqual(sql(), saved)
            assert.deepEqual(counters(), initialCounters)
            f.store.db.exec('DROP TRIGGER core_fail')
            f.call(sdk)
            assert.equal(Object.values(f.state().mall.localOrders).length, 1)
        } finally {
            f.protocol.encode = encode
            f.store.close()
        }
    }
})
