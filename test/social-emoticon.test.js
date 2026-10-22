import test from 'node:test'
import assert from 'node:assert/strict'
import { setup } from './social-wheel-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { audienceAllows } from '../src/chat-shields.js'
const writes = (f) => f.store.db.prepare('SELECT total_changes() AS n').get().n

test('6582 emits real6580 local playback and6583 peer event by table ID, ACK precedes peer broadcast', () => {
    const f = setup()
    try {
        for (const id of [1, 7, 12]) {
            const out = f.call('SelectEmoticons', { u32: id })
            assert.deepEqual(
                out.map((p) => p.id),
                [6580, 6582, 6583],
            )
            assert.equal(f.sync(out).cur_emoticons_id, id)
            assert.deepEqual(f.decode(out[2]), { player_id: f.session.id, emoticons_id: id })
            assert.deepEqual(out[2].audience, { kind: 'map', map: f.state().world.map_id, sender: f.session.id })
            assert(!out.some((p) => p.id === 9941 || p.id === 9942))
        }
        assert.equal(f.state().socialWheel.current, undefined)
    } finally {
        f.close()
    }
})
test('6582 transient read path makes zero SQLite writes and does not enqueue saved state or mutate actors, inventory or quests', () => {
    const f = setup()
    try {
        f.store.flushPending()
        const before = f.state(),
            token = f.store.readCacheToken(f.session.id),
            count = writes(f),
            pending = f.store.pending.size,
            transact = f.store.transact
        f.store.transact = () => {
            throw Error('playback must not transact')
        }
        try {
            for (let i = 0; i < 100; i++) {
                const out = f.call('SelectEmoticons', { u32: i % 2 ? 1 : 7 })
                assert.equal(f.sync(out).cur_emoticons_id, i % 2 ? 1 : 7)
            }
        } finally {
            f.store.transact = transact
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.size, pending)
        assert.equal(f.store.readCacheToken(f.session.id), token)
        assert.equal(writes(f), count)
        f.store.flushPending()
        assert.equal(writes(f), count)
    } finally {
        f.close()
    }
})
test('6582 identical consecutive actions remain playback events, login never replays selection', () => {
    const f = setup()
    try {
        for (let i = 0; i < 3; i++) assert.equal(f.sync(f.call('SelectEmoticons', { u32: 6 })).cur_emoticons_id, 6)
        const login = f.call('EnterGame', { open_id: 'social-wheel' }, {})
        assert.equal(f.sync(login).cur_emoticons_id, 0)
        assert(!login.some((p) => p.id === 6583))
    } finally {
        f.close()
    }
})
test('6582 malformed, unknown, locked or unavailable actions fail without SQL writes or account changes', () => {
    const f = setup()
    try {
        const row = f.tables.find('social_wheel', 7)
        for (const id of [0, 999]) {
            const before = f.state(),
                count = writes(f)
            assert.throws(
                () => f.call('SelectEmoticons', { u32: id }),
                (e) => e.code === ErrorCode.SocialEmotionsConfError,
            )
            assert.equal(writes(f), count)
            assert.deepEqual(f.state(), before)
        }
        row.lock_type = 2
        let before = f.state(),
            count = writes(f)
        assert.throws(
            () => f.call('SelectEmoticons', { u32: 7 }),
            (e) => e.code === ErrorCode.InvalidSocialWheelData,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(writes(f), count)
    } finally {
        f.close()
    }
    const locked = setup(':memory:', false)
    try {
        const before = locked.state(),
            count = writes(locked)
        assert.throws(
            () => locked.call('SelectEmoticons', { u32: 1 }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.equal(writes(locked), count)
        assert.deepEqual(locked.state(), before)
    } finally {
        locked.close()
    }
})
test('6582 all three actual codec failures publish no partial result and cannot mutate borrowed pending state', () => {
    const f = setup(),
        encode = f.protocol.encode
    try {
        f.call('UpdateEmoticonsWheel', { wheel_data: [{ index: 1, id: 1 }] })
        for (const id of [6580, 6582, 6583]) {
            const before = f.state(),
                count = writes(f),
                token = f.store.readCacheToken(f.session.id),
                type = f.protocol.byId.get(id).rsp
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('transient codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('SelectEmoticons', { u32: 1 }), /transient codec/)
            assert.equal(writes(f), count)
            assert.equal(f.store.readCacheToken(f.session.id), token)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})
test('6583 existing map audience ignores chat blacklist for non-chat events and excludes other maps', () => {
    const a = { kind: 'map', map: 100, sender: 1 }
    assert.equal(audienceAllows({ map: 100, blocked: new Set([1]) }, a, false), true)
    assert.equal(audienceAllows({ map: 200, blocked: new Set() }, a, false), false)
    assert.equal(audienceAllows({ map: 100, blocked: new Set([1]) }, a, true), false)
})
