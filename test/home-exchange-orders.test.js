import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { exchangeOrderWindow } from '../src/home-exchange-orders.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture() {
    const p = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let now = 1792584000,
        seq = 1
    const game = new Game(p, store, tables, { clock: () => now, rng: (min) => min })
    const call = (n, r = {}, who = session) => {
        const e = p.byName.get('CSProto' + n)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
            .map((x) => ({ id: x.id, data: p.decode(p.byId.get(x.id).rsp, x.payload) }))
    }
    call('EnterGame', { open_id: 'exchange-orders' })
    return {
        p,
        store,
        session,
        call,
        state: () => store.load(session.id).state,
        setNow: (n) => {
            now = n
        },
    }
}
test('6225 offers every configured tier, preserves the current board through queries, level increases and relogin, then rolls its real period', () => {
    const f = fixture()
    try {
        const locked = f.call('CSExchangeOrderBoard').find((p) => p.id === 6225).data
        assert.deepEqual(locked.base.order_guid, [])
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 10
        })
        const first = f.call('CSExchangeOrderBoard').find((p) => p.id === 6225).data
        assert.equal(first.base.order_guid.length, 6)
        assert.equal(first.base.refresh_times, 3)
        const rows = tables.get('home_exchange_order')
        assert.deepEqual(
            [1, 2, 3].map(
                (l) =>
                    first.base.order_guid.filter((o) => rows.find((r) => r.orderID === o.order_id).orderLevel === l)
                        .length,
            ),
            [3, 2, 1],
        )
        assert.equal(new Set(first.base.order_guid.map((o) => o.order_id)).size, 6)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 45
        })
        f.call('EnterGame', { open_id: 'exchange-orders' }, {})
        assert.deepEqual(f.call('CSExchangeOrderBoard').find((p) => p.id === 6225).data, first)
        f.setNow(first.base.end_time)
        const next = f.call('CSExchangeOrderBoard').find((p) => p.id === 6225).data
        assert.equal(next.base.order_guid.length, 9)
        assert.deepEqual(
            [1, 2, 3].map(
                (l) =>
                    next.base.order_guid.filter((o) => rows.find((r) => r.orderID === o.order_id).orderLevel === l)
                        .length,
            ),
            [5, 2, 2],
        )
        assert(next.base.order_guid.every((o) => !first.base.order_guid.some((old) => old.guid === o.guid)))
        assert.equal(next.base.start_time, first.base.end_time)
    } finally {
        f.store.close()
    }
})
test('configured order windows cover all weekdays at daily-reset boundaries and invalid query encoding does not save random orders', () => {
    for (let d = 0; d < 7; d++)
        for (const offset of [-1, 0, 1]) {
            const now = 1792536000 + d * 86400 + offset,
                w = exchangeOrderWindow(tables, now)
            assert(w.start <= now && now < w.end)
            assert.equal(w.end - w.start, w.period)
        }
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 45
        })
        const before = f.state(),
            encode = f.p.encode
        f.p.encode = function (n, r) {
            if (n === f.p.byId.get(6225).rsp) throw Error('injected order board encoding')
            return encode.call(this, n, r)
        }
        assert.throws(() => f.call('CSExchangeOrderBoard'), /injected order board/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
