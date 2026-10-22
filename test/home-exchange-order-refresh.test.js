import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
test('6226 preserves the slot GUID and tier, rerolls a different eligible order, persists its finite allowance and rolls back errors', () => {
    const p = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let seq = 1,
        now = 1792584000
    const game = new Game(p, store, tables, { clock: () => now, rng: (min) => min }),
        call = (n, r = {}) => {
            const e = p.byName.get('CSProto' + n)
            return game
                .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
                .map((x) => ({ id: x.id, data: p.decode(p.byId.get(x.id).rsp, x.payload) }))
        },
        state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'exchange-order-refresh' })
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 45
        })
        const first = call('CSExchangeOrderBoard').find((p) => p.id === 6225).data
        const slot = first.base.order_guid[0],
            level = tables.get('home_exchange_order').find((r) => r.orderID === slot.order_id).orderLevel
        let previous = slot.order_id
        for (let remaining = 2; remaining >= 0; remaining--) {
            const result = call('CSRefrshOneOrder', { order_guid: slot.guid }).find((p) => p.id === 6226).data
            const changed = result.base.order_guid.find((r) => r.guid === slot.guid)
            assert(changed)
            assert.notEqual(changed.order_id, previous)
            assert.equal(
                tables.get('home_exchange_order').find((r) => r.orderID === changed.order_id).orderLevel,
                level,
            )
            assert.equal(result.base.refresh_times, remaining)
            assert.deepEqual(result.rewards, [])
            previous = changed.order_id
        }
        const before = state()
        assert.throws(
            () => call('CSRefrshOneOrder', { order_guid: slot.guid }),
            (e) => e.code === ErrorCode.ExchangeOrderNotRefershTime,
        )
        assert.throws(
            () => call('CSRefrshOneOrder', { order_guid: 0xffffffff }),
            (e) => e.code === ErrorCode.HomeOrderNotExists,
        )
        assert.deepEqual(state(), before)
        now = first.base.end_time
        const next = call('CSExchangeOrderBoard').find((p) => p.id === 6225).data
        const newSlot = next.base.order_guid[0],
            snapshot = state(),
            encode = p.encode
        p.encode = function (n, r) {
            if (n === p.byId.get(6226).rsp) throw Error('injected refresh encoding')
            return encode.call(this, n, r)
        }
        assert.throws(() => call('CSRefrshOneOrder', { order_guid: newSlot.guid }), /injected refresh/)
        assert.deepEqual(state(), snapshot)
    } finally {
        store.close()
    }
})
