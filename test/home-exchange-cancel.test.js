import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
test('6223 returns the original reserved stacks and expiry, repeated cancellation is harmless, new reservations can be canceled again', () => {
    const p = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let seq = 1,
        now = 1792584000
    const game = new Game(p, store, tables, { clock: () => now }),
        call = (n, r = {}) => {
            const e = p.byName.get('CSProto' + n)
            return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
        }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'exchange-cancel' })
        store.transact(session.id, 0, (s) => {
            s.player.sbag_infos.items = []
            grantRewards(tables, s, [{ itemtype: 3, itemid: 400101, itemnum: 10 }])
            s.player.sbag_infos.items[0].deadtime = now + 5
        })
        const before = state().player.sbag_infos.items[0]
        call('CSAddExchangeObj', { id: 10360011, num: 7, type: 3 })
        now += 6
        const result = call('CSCancelExangeObj', { id: 10360011 })
        assert(result.findIndex((p) => p.id === 6229) < result.findIndex((p) => p.id === 6223))
        assert.deepEqual(state().player.sbag_infos.items, [before])
        assert.deepEqual(state().homeExchange.box, [])
        call('CSCancelExangeObj', { id: 10360011 })
        assert.deepEqual(state().player.sbag_infos.items, [before])
        assert.throws(
            () => call('CSAddExchangeObj', { id: 10360011, num: 1, type: 3 }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        store.transact(session.id, 0, (s) => {
            delete s.player.sbag_infos.items[0].deadtime
        })
        call('CSAddExchangeObj', { id: 10360011, num: 10, type: 3 })
        call('CSCancelExangeObj', { id: 10360011 })
        assert.equal(state().player.sbag_infos.items[0].itemnum, 10)
    } finally {
        store.close()
    }
})
test('cancellation restores a compacted zero stack and rolls back on wire failure, while invalid removals preserve escrow', () => {
    const p = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let seq = 1
    const game = new Game(p, store, tables, { clock: () => 1792584000 }),
        call = (n, r = {}) => {
            const e = p.byName.get('CSProto' + n)
            return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
        },
        state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'exchange-cancel-atomic' })
        store.transact(session.id, 0, (s) => {
            s.player.sbag_infos.items = []
            grantRewards(tables, s, [{ itemtype: 3, itemid: 400101, itemnum: 4 }])
        })
        const stack = state().player.sbag_infos.items[0]
        call('CSAddExchangeObj', { id: 10360011, num: 4, type: 3 })
        store.transact(session.id, 0, (s) => {
            s.player.sbag_infos.items = []
        })
        const before = state(),
            encode = p.encode
        p.encode = function (n, r) {
            if (n === p.byId.get(6229).rsp) throw Error('injected cancellation response')
            return encode.call(this, n, r)
        }
        assert.throws(() => call('CSCancelExangeObj', { id: 10360011 }), /injected/)
        assert.deepEqual(state(), before)
        p.encode = encode
        assert.throws(
            () => call('CSCancelExangeObj', { id: 10310041 }),
            (e) => e.code === ErrorCode.ExchangeCancelNotFind,
        )
        assert.deepEqual(state(), before)
        call('CSCancelExangeObj', { id: 10360011 })
        assert.deepEqual(state().player.sbag_infos.items, [stack])
    } finally {
        store.close()
    }
})
