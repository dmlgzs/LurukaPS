import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture() {
    const p = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let now = 1792584000,
        seq = 1
    const game = new Game(p, store, tables, { clock: () => now, rng: (min) => min })
    const call = (n, r = {}) => {
        const e = p.byName.get('CSProto' + n)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
            .map((x) => ({ id: x.id, data: p.decode(p.byId.get(x.id).rsp, x.payload) }))
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'exchange-deposit' })
    store.transact(session.id, 0, (s) => {
        grantRewards(tables, s, [
            { itemtype: 3, itemid: 9000301, itemnum: 4 },
            { itemtype: 3, itemid: 400101, itemnum: 80 },
            { itemtype: 3, itemid: 9000201, itemnum: 2 },
        ])
    })
    return {
        p,
        store,
        session,
        call,
        state,
        setNow: (n) => {
            now = n
        },
    }
}
const count = (s, id) => s.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)
test('6222 decodes each observed exchange row ID, reserves actual goods and publishes inventory and box before ACK', () => {
    const f = fixture()
    try {
        const rows = [
            [10310041, 1, '2bde43fd8056e1efeaa4905272222f52d99ef540c4b3864143406f638731e708'],
            [10360011, 71, 'f25db7973820204d784f3f012a545b10c589b420a8b029fac7730af740d178a9'],
            [10310121, 1, '26a92f002b1ab6d9bafc74ed76fd85a95a6b8dd60c0762e9e8562c7485c51599'],
        ]
        for (const [id, num, hash] of rows) {
            const r = { id, num, guid: 0, type: 3 },
                config = tables.find('home_exchange_item', id),
                before = count(f.state(), config.itemId)
            assert.equal(
                createHash('sha256')
                    .update(f.p.encode(f.p.byId.get(6222).req, r))
                    .digest('hex'),
                hash,
            )
            const result = f.call('CSAddExchangeObj', r)
            assert.equal(count(f.state(), config.itemId), before - num)
            const box = result.find((p) => p.id === 6229).data
            assert.equal(box.obj_info.find((e) => e.id === id).num, num)
            assert(result.findIndex((p) => p.id === 6023) < result.findIndex((p) => p.id === 6222))
            assert(result.findIndex((p) => p.id === 6229) < result.findIndex((p) => p.id === 6222))
        }
        const old = f.state().homeExchange.box.find((e) => e.id === 10360011)
        f.call('CSAddExchangeObj', { id: 10360011, num: 2, type: 3 })
        assert.equal(f.state().homeExchange.box.find((e) => e.id === 10360011).num, old.num + 2)
        assert.equal(count(f.state(), 400101), 7)
        assert.equal(
            f
                .state()
                .homeExchange.box.find((e) => e.id === 10360011)
                .items.reduce((n, i) => n + i.itemnum, 0),
            73,
        )
    } finally {
        f.store.close()
    }
})
test('shipment reservation rejects invalid, unavailable and over-limit requests atomically', () => {
    const f = fixture()
    try {
        for (const r of [
            { id: 10360011, num: 0, type: 3 },
            { id: 10360011, num: 81, type: 3 },
            { id: 10360011, num: 1, type: 15 },
            { id: 10360011, num: 1, type: 3, guid: 123 },
            { id: 400101, num: 1, type: 3 },
        ]) {
            const before = f.state()
            assert.throws(() => f.call('CSAddExchangeObj', r))
            assert.deepEqual(f.state(), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.homeExchange = {
                history: [{ history_time: 1792512000, profit: 5000000, settle_num: 1, extra_num: 0 }],
                box: [],
            }
        })
        assert.throws(
            () => f.call('CSAddExchangeObj', { id: 10360011, num: 1, type: 3 }),
            (e) => e.code === ErrorCode.ExchangeSettleLimit,
        )
        f.setNow(1792598400)
        f.store.transact(f.session.id, 0, (s) => {
            s.homeExchange.history = []
        })
        f.call('CSAddExchangeObj', { id: 10360011, num: 1, type: 3 })
        assert.equal(f.state().homeExchange.box[0].num, 1, 'an overnight booking remains valid')
    } finally {
        f.store.close()
    }
})
test('reservation preserves expiring stack identity and failed box encoding rolls back both inventory and escrow', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const item = s.player.sbag_infos.items.find((i) => i.itemid === 400101)
            item.deadtime = 1792584010
        })
        const before = f.state(),
            encode = f.p.encode
        f.p.encode = function (name, value) {
            if (name === f.p.byId.get(6229).rsp) throw Error('injected box encoding failure')
            return encode.call(this, name, value)
        }
        assert.throws(() => f.call('CSAddExchangeObj', { id: 10360011, num: 1, type: 3 }), /injected box/)
        assert.deepEqual(f.state(), before)
        f.p.encode = encode
        f.call('CSAddExchangeObj', { id: 10360011, num: 1, type: 3 })
        const reservation = f.state().homeExchange.box[0].items[0]
        assert.equal(reservation.deadtime, 1792584010)
        assert.equal(reservation.guid, before.player.sbag_infos.items.find((i) => i.itemid === 400101).guid)
        f.setNow(1792584020)
        assert.throws(
            () => f.call('CSAddExchangeObj', { id: 10360011, num: 1, type: 3 }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
    } finally {
        f.store.close()
    }
})
