import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture() {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (n, r = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + n)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'exchange-history' })
    return { protocol, store, game, session, call, state: () => store.load(session.id).state }
}
test('6220 returns a genuine empty report for an account without exchange activity', () => {
    const f = fixture()
    try {
        const before = f.state()
        const report = f.call('CSHistoryReport').find((p) => p.id === 6220).data
        assert.deepEqual(report.info, [])
        assert.deepEqual(report.extra_info.award.rewards, [])
        assert.equal(f.state().homeExchange, undefined)
        assert.deepEqual(f.state().player, before.player)
    } finally {
        f.store.close()
    }
})
test('6220 reads persisted financial values and consumes a display notice once without delivering it again', () => {
    const f = fixture()
    try {
        const history = [
            { history_time: 1799900000, profit: 120, settle_num: 3, extra_num: 6 },
            { history_time: 1799800000, profit: 50, settle_num: 1, extra_num: 0 },
        ]
        f.store.transact(f.session.id, 0, (s) => {
            s.homeExchange = {
                history,
                pendingNotice: { rewards: [{ itemtype: 10, itemid: 103, itemnum: 126 }], src: 144 },
            }
        })
        const player = f.state().player
        const first = f.call('CSHistoryReport').find((p) => p.id === 6220).data
        assert.deepEqual(
            first.info,
            history.toSorted((a, b) => a.history_time - b.history_time),
        )
        assert.equal(first.extra_info.award.rewards[0].itemnum, 126)
        const second = f.call('CSHistoryReport').find((p) => p.id === 6220).data
        assert.deepEqual(second.info, first.info)
        assert.deepEqual(second.extra_info.award.rewards, [])
        f.call('EnterGame', { open_id: 'exchange-history' }, {})
        assert.deepEqual(f.call('CSHistoryReport').find((p) => p.id === 6220).data.info, first.info)
        assert.deepEqual(f.state().player, player)
    } finally {
        f.store.close()
    }
})
test('failed financial response encoding rolls back notice consumption', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.homeExchange = { history: [], pendingNotice: { rewards: [{ itemtype: 10, itemid: 103, itemnum: 126 }] } }
        })
        const before = f.state(),
            encode = f.protocol.encode
        f.protocol.encode = function (name, data) {
            if (name === f.protocol.byId.get(6220).rsp) throw Error('injected history encoding failure')
            return encode.call(this, name, data)
        }
        assert.throws(() => f.call('CSHistoryReport'), /injected history/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        assert.equal(f.call('CSHistoryReport').find((p) => p.id === 6220).data.extra_info.award.rewards.length, 1)
    } finally {
        f.store.close()
    }
})
