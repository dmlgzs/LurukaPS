import test from 'node:test'
import assert from 'node:assert/strict'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('9948 returns a real empty/full owned list without creating ledger entries or writing SQLite', () => {
    const f = chatShieldFixture('query')
    try {
        const before = structuredClone(f.state(f.a)),
            writes = f.store.db.prepare('select total_changes() n').get().n
        assert.deepEqual(f.reply(f.call(f.a, 'ChatGetShieldList'), 9948), { err: ErrorCode.Succ, items: [] })
        assert.deepEqual(f.state(f.a), before)
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
        f.change(f.a, f.b, 1)
        const stamp = f.now()
        f.advance(10)
        f.change(f.a, f.c, 1)
        assert.deepEqual(f.reply(f.call(f.a, 'ChatGetShieldList'), 9948), {
            err: ErrorCode.Succ,
            items: [
                { pid: f.c.id, time: f.now() },
                { pid: f.b.id, time: stamp },
            ],
        })
        f.change(f.a, f.b, 2)
        assert.deepEqual(f.reply(f.call(f.a, 'ChatGetShieldList'), 9948).items, [{ pid: f.c.id, time: f.now() }])
    } finally {
        f.store.close()
    }
})

test('empty-request query cannot select another account and warm polling avoids whole profile reads and writes', () => {
    const f = chatShieldFixture('query-owner')
    try {
        f.change(f.a, f.b, 1)
        f.change(f.b, f.c, 1)
        const forged = f.game.dispatch(f.a, {
            id: 9948,
            seq: 1000,
            payload: f.protocol.encode('CSUint32', { u32: f.b.id }),
        })
        assert.deepEqual(
            f.reply(forged, 9948).items.map((r) => r.pid),
            [f.b.id],
        )
        const writes = f.store.db.prepare('select total_changes() n').get().n,
            load = f.store.load,
            read = f.store.read
        let reads = 0
        f.store.load = function (...args) {
            reads++
            return load.apply(this, args)
        }
        f.store.read = function (...args) {
            reads++
            return read.apply(this, args)
        }
        try {
            for (let i = 0; i < 300; i++) assert.equal(f.reply(f.call(f.a, 'ChatGetShieldList'), 9948).items.length, 1)
        } finally {
            f.store.load = load
            f.store.read = read
        }
        assert.equal(reads, 0)
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
        assert.throws(() => f.game.dispatch({}, { id: 9948, seq: 1, payload: Buffer.alloc(0) }))
    } finally {
        f.store.close()
    }
})

test('list encoding failures remain read-only and malformed owned mute records produce a precise error', () => {
    const f = chatShieldFixture('query-codec'),
        encode = f.protocol.encode,
        warn = console.warn
    try {
        f.change(f.a, f.b, 1)
        const before = structuredClone(f.state(f.a)),
            writes = f.store.db.prepare('select total_changes() n').get().n
        f.protocol.encode = function (name, ...args) {
            if (name === 'cs.SCChatGetShieldList' || name === 'SCChatGetShieldList')
                throw Error('shield list encoding failed')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call(f.a, 'ChatGetShieldList'), /shield list encoding failed/)
        assert.deepEqual(f.state(f.a), before)
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
        f.protocol.encode = encode
        console.warn = () => {}
        f.store.transact(f.a.id, 0, (s) => {
            s.chatShields[f.b.id] = 'bad'
        })
        const bad = structuredClone(f.state(f.a))
        assert.throws(
            () => f.call(f.a, 'ChatGetShieldList'),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(f.a), bad)
    } finally {
        console.warn = warn
        f.protocol.encode = encode
        f.store.close()
    }
})

test('chat mute list is distinct from legacy blacklist data, and removing an orphaned mute remains possible', () => {
    const f = chatShieldFixture('query-separation'),
        warn = console.warn
    try {
        f.change(f.a, f.b, 1)
        f.store.transact(f.a.id, 0, (s) => {
            s.blockedPlayers = [f.c.id]
        })
        assert.deepEqual(
            f.reply(f.call(f.a, 'ChatGetShieldList'), 9948).items.map((r) => r.pid),
            [f.b.id],
        )
        console.warn = () => {}
        f.store.transact(f.a.id, 0, (s) => {
            s.blockedPlayers = 'damaged'
        })
        assert.deepEqual(
            f.reply(f.call(f.a, 'ChatGetShieldList'), 9948).items.map((r) => r.pid),
            [f.b.id],
        )
        // Simulate an imported mute whose target profile no longer exists.
        f.store.transact(f.a.id, 0, (s) => {
            s.chatShields[0xfffffffe] = f.now()
        })
        f.call(f.a, 'ChatShieldOp', { tar_id: 0xfffffffe, op: 2 })
        assert.deepEqual(
            f.reply(f.call(f.a, 'ChatGetShieldList'), 9948).items.map((r) => r.pid),
            [f.b.id],
        )
    } finally {
        console.warn = warn
        f.store.close()
    }
})
