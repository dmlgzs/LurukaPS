import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { chatRoutingInfo, audienceAllows, chatShieldItems } from '../src/chat-shields.js'
import { chatSnapshots } from '../src/handlers/chat.js'
import { ErrorCode } from '../src/error-codes.js'

test('9947 adds/removes independent chat mutes, returns the full list, and preserves first mute time on repeats', () => {
    const f = chatShieldFixture('operations')
    try {
        const before = structuredClone(f.state(f.a))
        assert.deepEqual(f.reply(f.change(f.a, f.b, 1)), {
            err: ErrorCode.Succ,
            items: [{ pid: f.b.id, time: f.now() }],
        })
        const stamp = f.now()
        f.advance(10)
        assert.deepEqual(f.reply(f.change(f.a, f.b, 1)), { err: ErrorCode.Succ, items: [{ pid: f.b.id, time: stamp }] })
        f.change(f.a, f.c, 1)
        assert.deepEqual(
            chatShieldItems(f.state(f.a)).map((r) => r.pid),
            [f.c.id, f.b.id],
        )
        assert.deepEqual(f.state(f.a).blockedPlayers, before.blockedPlayers)
        assert.deepEqual(f.state(f.a).friends, before.friends)
        assert.deepEqual(f.state(f.a).world, before.world)
        assert.deepEqual(f.reply(f.change(f.a, f.b, 2)).items, [{ pid: f.c.id, time: f.now() }])
        assert.deepEqual(f.reply(f.change(f.a, f.b, 2)).items, [{ pid: f.c.id, time: f.now() }])
    } finally {
        f.store.close()
    }
})

test('mute suppresses private/group delivery, counts and visible history without deleting the shared archive', () => {
    const f = chatShieldFixture('delivery')
    try {
        const first = f.send(f.b, f.a, 'before')
        assert(first.some((p) => p.id === 9932 && p.recipient === f.a.id))
        const muted = f.change(f.a, f.b, 1)
        assert(
            muted.some((p) => p.id === f.protocol.byName.get('CSProtoChatMsgCntSync').id),
            'read count update is pushed',
        )
        const hidden = f.send(f.b, f.a, 'muted')
        assert(!hidden.some((p) => p.recipient === f.a.id))
        assert.equal(f.store.chatHistory(f.a.id, f.b.id).length, 2)
        const list = chatSnapshots(f.store, f.state(f.a), f.a.id)
        assert.equal(list.counts.msg_list.find((r) => r.id === f.b.id).cnt, 0)
        assert.deepEqual(list.list.info.find((r) => r.id === f.b.id).chats, [])
        const history = f.call(f.a, 'ChatInfoSync', { id: f.b.id })
        assert.deepEqual(f.reply(history, f.protocol.byName.get('CSProtoChatInfoSync').id).chats, [])
        f.store.transact(f.b.id, 0, (s) => {
            s.chatGroups = { 77: [f.a.id, f.b.id, f.c.id] }
        })
        const group = f.send(f.b, 77, 'group', 1)
        assert(!group.some((p) => p.recipient === f.a.id))
        assert(group.some((p) => p.id === 9932 && p.recipient === f.c.id))
        f.change(f.a, f.b, 2)
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, f.state(f.a).chatReads[f.b.id]), 0)
        assert.equal(f.store.chatHistory(f.a.id, f.b.id).length, 2)
        const delivered = f.send(f.b, f.a, 'after')
        assert(delivered.some((p) => p.id === 9932 && p.recipient === f.a.id))
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, f.state(f.a).chatReads[f.b.id]), 1)
        // A repeated remove must not consume a new, already-unmuted unread.
        f.change(f.a, f.b, 2)
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, f.state(f.a).chatReads[f.b.id]), 1)
    } finally {
        f.store.close()
    }
})

test('capacity is table-driven; invalid targets/operations and missing configuration fail atomically', () => {
    const f = chatShieldFixture('limits')
    try {
        for (const [r, code] of [
            [{ tar_id: f.a.id, op: 1 }, ErrorCode.InvalidTarget],
            [{ tar_id: 0xffffffff, op: 1 }, ErrorCode.InvalidTarget],
            [{ tar_id: f.b.id, op: 99 }, ErrorCode.FriendOpIsFail],
        ]) {
            const before = structuredClone(f.state(f.a))
            assert.throws(
                () => f.call(f.a, 'ChatShieldOp', r),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(f.a), before)
        }
        const row = f.tables.get('game').find((r) => r.title === 'CHAT_SHIELD_LIMIT')
        assert.equal(Number(row.value), 100)
        row.value = '1'
        f.change(f.a, f.b, 1)
        const before = structuredClone(f.state(f.a))
        assert.throws(
            () => f.change(f.a, f.c, 1),
            (e) => e.code === ErrorCode.BanNumMax,
        )
        assert.deepEqual(f.state(f.a), before)
        assert.equal(f.reply(f.change(f.a, f.b, 1)).items.length, 1)
        row.value = 'bad'
        assert.throws(
            () => f.change(f.a, f.c, 1),
            (e) => e.code === ErrorCode.GameConfig,
        )
        f.change(f.a, f.b, 2)
        assert.deepEqual(chatShieldItems(f.state(f.a)), [])
    } finally {
        f.store.close()
    }
})

test('routing metadata is cached, honors one-way receive mutes, and never blocks non-chat gameplay packets', () => {
    const f = chatShieldFixture('routing')
    try {
        f.change(f.a, f.b, 1)
        const route = chatRoutingInfo(f.store, f.a.id)
        const audience = { kind: 'map', map: route.map, sender: f.b.id }
        assert.equal(audienceAllows(route, audience, true), false)
        assert.equal(audienceAllows(route, audience, false), true)
        assert.equal(route.pets, undefined)
        assert.equal(route.player, undefined)
        const load = f.store.load,
            read = f.store.read
        let reads = 0
        f.store.load = function (...a) {
            reads++
            return load.apply(this, a)
        }
        f.store.read = function (...a) {
            reads++
            return read.apply(this, a)
        }
        try {
            for (let i = 0; i < 300; i++) assert.equal(chatRoutingInfo(f.store, f.a.id), route)
        } finally {
            f.store.load = load
            f.store.read = read
        }
        assert.equal(reads, 0)
        const outgoing = f.send(f.a, f.b, 'explicit outgoing')
        assert(outgoing.some((p) => p.id === 9932 && p.recipient === f.b.id))
        f.store.transact(
            f.a.id,
            0,
            (s) => {
                s.world.map_id = 101
            },
            { defer: true },
        )
        assert.equal(chatRoutingInfo(f.store, f.a.id).map, 101)
        f.store.flushPending()
        assert.equal(chatRoutingInfo(f.store, f.a.id).map, 101)
    } finally {
        f.store.close()
    }
})

test('invalid receiver privacy fails closed for chat, still permits gameplay, and emits one diagnostic until repair', () => {
    const f = chatShieldFixture('damaged'),
        warn = console.warn,
        messages = []
    try {
        console.warn = (...args) => messages.push(args.join(' '))
        f.store.transact(f.c.id, 0, (s) => {
            s.chatShields = { [f.b.id]: -1 }
        })
        for (let i = 0; i < 2; i++) {
            const route = chatRoutingInfo(f.store, f.c.id)
            assert.equal(audienceAllows(route, { kind: 'map', map: route.map, sender: f.b.id }, true), false)
            assert.equal(audienceAllows(route, { kind: 'map', map: route.map, sender: f.b.id }, false), true)
            f.store.transact(f.c.id, 0, (s) => {
                s.world.angle++
            })
        }
        assert.equal(messages.length, 1)
        f.store.transact(f.c.id, 0, (s) => {
            s.chatShields = {}
        })
        assert(chatRoutingInfo(f.store, f.c.id).blocked instanceof Set)
    } finally {
        console.warn = warn
        f.store.close()
    }
})

test('actual list/notification encoding failures roll back mute state, read orders and routing cache versions', () => {
    const f = chatShieldFixture('codec'),
        encode = f.protocol.encode
    try {
        f.send(f.b, f.a, 'unread')
        const before = structuredClone(f.state(f.a)),
            token = f.store.readCacheToken(f.a.id)
        for (const type of ['SCChatShieldOp', 'SCChatMsgCnt']) {
            f.protocol.encode = function (name, ...args) {
                if (name === type || name === 'cs.' + type) throw Error('shield encoding failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.change(f.a, f.b, 1), /shield encoding failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.equal(f.store.readCacheToken(f.a.id), token)
            f.protocol.encode = encode
        }
        f.change(f.a, f.b, 1)
        assert(chatRoutingInfo(f.store, f.a.id).blocked.has(f.b.id))
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('mute records and read transitions survive SQLite reopen and actual login with the other account unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-chat-shields-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = chatShieldFixture('reopen', file)
        const other = structuredClone(f.state(f.b))
        f.change(f.a, f.b, 1)
        const before = chatShieldItems(f.state(f.a))
        assert.deepEqual(f.state(f.b), other)
        f.store.close()
        f = chatShieldFixture('reopen', file)
        assert.deepEqual(chatShieldItems(f.state(f.a)), before)
        assert(chatRoutingInfo(f.store, f.a.id).blocked.has(f.b.id))
        f.change(f.a, f.b, 2)
        assert(!chatRoutingInfo(f.store, f.a.id).blocked.has(f.b.id))
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-chat-shields-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
