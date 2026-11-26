import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { firstShareSnapshot, claimFirstShare } from '../src/activity-first-share.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture() {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let session = {},
        seq = 1,
        last
    const game = new Game(protocol, store, tables, { clock: () => Date.UTC(2026, 10, 27) / 1000 })
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) }
    }
    const dispatch = (r, who = session) => {
        last = game.dispatch(who, r)
        return protocol.decode(protocol.byId.get(r.id).rsp, last.find((p) => p.id === r.id).payload)
    }
    const call = (name, data) => dispatch(frame(name, data))
    const login = () => {
        const next = {}
        dispatch(frame('EnterGame', { open_id: 'private-first-share' }), next)
        session = next
        return last
    }
    login()
    return {
        protocol,
        store,
        game,
        frame,
        dispatch,
        call,
        login,
        packets: () => last,
        state: () => store.load(session.id).state,
        saved: () => store.load(session.id),
        close: () => store.close(),
    }
}
class CurrentConsumer {
    // Direct current GameEventStore constructor default and 10442 consumer.
    firstType = 1
    shown = []
    consume(f, packets) {
        for (const p of packets) {
            if (p.id === 10442)
                this.firstType = f.protocol.decode(f.protocol.byId.get(10442).rsp, p.payload).share_first_reward_type
            if (p.id === 10441) {
                const v = f.protocol.decode(f.protocol.byId.get(10441).rsp, p.payload)
                if (v.rewards.length) this.shown.push(...v.rewards)
            }
        }
    }
    get available() {
        return this.firstType === 0
    }
}
test('current PC save/public photo share1 uses table row1/drop5000008 once;10442 fixes native default and precedes reward callback', () => {
    const f = fixture()
    try {
        const model = new CurrentConsumer()
        assert.equal(model.available, false)
        model.consume(f, f.packets())
        assert.equal(model.available, true)
        assert.deepEqual(firstShareSnapshot(f.state()), { share_first_reward_type: 0 })
        const definition = tables.get('share_reward')
        assert.deepEqual(definition, [{ rewardId: 1, rewardType: 1, shareDrop: 5000008 }])
        const before = f.state().player.basic_info.diamond
        const result = f.call('ShareFirstReward', { u32: 1 })
        assert.deepEqual(
            result.rewards.map((x) => [x.itemtype, x.itemid, x.itemnum]),
            [[10, 1, 20]],
        )
        assert.equal(f.state().player.basic_info.diamond, before + 20)
        const ids = f.packets().map((x) => x.id)
        assert(ids.indexOf(10442) < ids.indexOf(10441))
        model.consume(f, f.packets())
        assert.equal(model.available, false)
        assert.equal(model.shown.length, 1)
        for (const type of [1, 3, 4]) {
            assert.deepEqual(f.call('ShareFirstReward', { u32: type }).rewards, [])
            model.consume(f, f.packets())
        }
        assert.equal(model.shown.length, 1)
        assert.equal(f.state().player.basic_info.diamond, before + 20)
        const cold = new CurrentConsumer()
        cold.consume(f, f.login())
        assert.equal(cold.available, false)
        assert.equal(cold.firstType, 1)
    } finally {
        f.close()
    }
})
test('current Activity/Gacha share3/4 use the same global first reward rather than per-content or per-event grants', () => {
    for (const type of [3, 4]) {
        const f = fixture()
        try {
            const before = f.state().player.basic_info.diamond
            assert.equal(f.call('ShareFirstReward', { u32: type }).rewards[0].itemnum, 20)
            assert.deepEqual(firstShareSnapshot(f.state()), { share_first_reward_type: type })
            assert.deepEqual(f.call('ShareFirstReward', { u32: 1 }).rewards, [])
            assert.equal(f.state().player.basic_info.diamond, before + 20)
            const model = new CurrentConsumer()
            model.consume(f, f.login())
            assert.equal(model.available, false)
        } finally {
            f.close()
        }
    }
})
test('unknown content IDs and unproved video2 source reject atomically', () => {
    const f = fixture()
    try {
        for (const [type, code] of [
            [0, ErrorCode.InvalidArgument],
            [5, ErrorCode.InvalidArgument],
            [2, ErrorCode.FunctionClosed],
        ]) {
            const before = f.saved()
            assert.throws(() => f.call('ShareFirstReward', { u32: type }), { code })
            assert.deepEqual(f.saved(), before)
        }
    } finally {
        f.close()
    }
})
test('reward ACK codec and real SQL failure roll back currency/first state/revision; original request retry grants once', () => {
    const f = fixture()
    try {
        const before = f.saved(),
            r = f.frame('ShareFirstReward', { u32: 1 }),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byId.get(10441).rsp) throw Error('share-ack-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.dispatch(r), /share-ack-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.saved(), before)
        f.store.db.exec(
            "CREATE TRIGGER share_review_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'share-review-sql'); END",
        )
        try {
            assert.throws(() => f.dispatch(r), /share-review-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER share_review_abort')
        }
        assert.deepEqual(f.saved(), before)
        assert.equal(f.dispatch(r).rewards[0].itemnum, 20)
        assert.deepEqual(f.dispatch(r).rewards, [])
        assert.equal(f.state().player.basic_info.diamond, before.state.player.basic_info.diamond + 20)
    } finally {
        f.close()
    }
})
test('damaged saved claims and unavailable current reward definitions remain strict, without guessed drops', () => {
    for (const valueof of [null, {}, { version: 1, type: 2, time: 1800000000 }, { version: 1, type: 1, time: 0 }])
        assert.throws(() => firstShareSnapshot({ firstShareReward: valueof }), { code: ErrorCode.GameConfig })
    for (const rows of [
        [],
        [{ rewardId: 1, rewardType: 2, shareDrop: 5000008 }],
        [{ rewardId: 1, rewardType: 1, shareDrop: 0 }],
    ]) {
        const state = {},
            c = { state, tables: { get: () => rows } }
        assert.throws(() => claimFirstShare(c, 1), {
            code: !rows.length
                ? ErrorCode.ActivityRewardConfNone
                : rows[0].shareDrop === 0
                  ? ErrorCode.GameConfig
                  : ErrorCode.FunctionClosed,
        })
        assert.deepEqual(state, {})
    }
})
