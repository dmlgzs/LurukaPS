import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { chatSnapshots } from '../src/handlers/chat.js'
import { ErrorCode } from '../src/error-codes.js'

const history = (f, session, peer) => f.reply(f.call(session, 'ChatInfoSync', { id: peer.id }), 9931)
const remove = (f, session, peer) => f.call(session, 'DelFriendChat', { id: peer.id ?? peer })

test('9934 clears only the caller view and unread marker, preserving the peer archive and account state', () => {
    const f = chatShieldFixture('conversation-delete')
    try {
        f.send(f.b, f.a, 'incoming')
        f.send(f.a, f.b, 'outgoing')
        const other = structuredClone(f.state(f.b)),
            rows = f.store.chatHistory(f.a.id, f.b.id)
        const packets = remove(f, f.a, f.b)
        assert(packets.findIndex((p) => p.id === 9929) < packets.findIndex((p) => p.id === 9934))
        assert.deepEqual(f.reply(packets, 9929).msg_list, [{ id: f.b.id, cnt: 0 }])
        assert.deepEqual(history(f, f.a, f.b).chats, [])
        assert.equal(history(f, f.b, f.a).chats.length, 2)
        assert.deepEqual(f.store.chatHistory(f.a.id, f.b.id), rows)
        assert.deepEqual(f.state(f.b), other)
        assert.equal(chatSnapshots(f.store, f.state(f.a), f.a.id).list.info.length, 0)
        assert.equal(chatSnapshots(f.store, f.state(f.b), f.b.id).list.info.length, 1)
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, f.state(f.a).chatReads[f.b.id]), 0)
        assert.equal(f.state(f.a).chatShields, undefined)
    } finally {
        f.store.close()
    }
})

test('explicit reopening and new messages restore the conversation without resurrecting cleared history', () => {
    const f = chatShieldFixture('conversation-reopen')
    try {
        f.send(f.b, f.a, 'old')
        remove(f, f.a, f.b)
        f.call(f.a, 'CreateFriendChat', { id: f.b.id })
        assert.deepEqual(history(f, f.a, f.b).chats, [])
        assert.equal(chatSnapshots(f.store, f.state(f.a), f.a.id).list.info.length, 1)
        remove(f, f.a, f.b)
        const sent = f.send(f.b, f.a, 'new')
        assert(sent.some((p) => p.id === 9932 && p.recipient === f.a.id))
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, f.state(f.a).chatReads[f.b.id]), 1)
        assert.equal(chatSnapshots(f.store, f.state(f.a), f.a.id).list.info.length, 1)
        assert.deepEqual(
            history(f, f.a, f.b).chats.map((r) => Buffer.from(r.msg, 'base64').toString()),
            ['new'],
        )
        assert.equal(history(f, f.b, f.a).chats.length, 2)
        f.change(f.a, f.b, 1)
        f.change(f.a, f.b, 2)
        assert.equal(history(f, f.a, f.b).chats.length, 1, 'unmuting does not resurrect cleared history')
    } finally {
        f.store.close()
    }
})

test('bulk history respects each caller cut and cannot delete another conversation or group', () => {
    const f = chatShieldFixture('conversation-scope')
    try {
        f.send(f.b, f.a, 'b')
        f.send(f.c, f.a, 'c')
        remove(f, f.a, f.b)
        const data = f.reply(f.call(f.a, 'ChatSyncNew', { pids: [f.b.id, f.c.id] }), 9943)
        assert.equal(data.chat_infos.find((r) => r.id === f.b.id).chats.length, 0)
        assert.equal(data.chat_infos.find((r) => r.id === f.c.id).chats.length, 1)
        assert.equal(history(f, f.b, f.a).chats.length, 1)
        const before = structuredClone(f.state(f.a))
        for (const peer of [0, f.a.id]) {
            assert.throws(
                () => remove(f, f.a, peer),
                (e) => e.code === ErrorCode.InvalidTarget,
            )
            assert.deepEqual(f.state(f.a), before)
        }
        // A removed account/no-message peer is still safe to clear: there is no target-state mutation.
        remove(f, f.a, 0xffffffff)
        assert.deepEqual(f.state(f.a).chatConversationCuts[0xffffffff], { order: 0, hidden: true })
    } finally {
        f.store.close()
    }
})

test('delete count/ack codec failures roll back cutoff and read state; malformed stored cutoff is separate', () => {
    const f = chatShieldFixture('conversation-codec'),
        encode = f.protocol.encode
    try {
        f.send(f.b, f.a, 'keep')
        for (const type of ['cs.SCChatMsgCnt', 'cs.ProtoNullRsp']) {
            const before = structuredClone(f.state(f.a)),
                token = f.store.readCacheToken(f.a.id)
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('delete codec failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => remove(f, f.a, f.b), /delete codec failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.equal(f.store.readCacheToken(f.a.id), token)
            f.protocol.encode = encode
        }
        f.store.transact(f.a.id, 0, (s) => {
            s.chatConversationCuts = { [f.b.id]: { order: -1, hidden: true } }
        })
        assert.throws(
            () => remove(f, f.a, f.b),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.equal(f.store.chatHistory(f.a.id, f.b.id).length, 1)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('deleted conversation remains hidden after SQLite reopen and a new incoming message becomes unread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-chat-conversation-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = chatShieldFixture('conversation-restart', file)
        f.send(f.b, f.a, 'old')
        remove(f, f.a, f.b)
        f.store.close()
        f = chatShieldFixture('conversation-restart', file)
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-conversation-restart-a' })
        assert.deepEqual(f.reply(packets, 9930).info, [])
        assert.deepEqual(history(f, f.a, f.b).chats, [])
        assert.equal(history(f, f.b, f.a).chats.length, 1)
        f.send(f.b, f.a, 'fresh')
        assert.equal(history(f, f.a, f.b).chats.length, 1)
        assert.equal(chatSnapshots(f.store, f.state(f.a), f.a.id).counts.msg_list[0].cnt, 1)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-chat-conversation-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('history queries stay read-only and new outgoing messages reopen only the cleared caller view', () => {
    const f = chatShieldFixture('conversation-read-cost')
    try {
        f.send(f.b, f.a, 'old')
        remove(f, f.a, f.b)
        f.store.flushPending()
        const before = f.store.db.prepare('SELECT total_changes() AS n').get().n,
            token = f.store.readCacheToken(f.a.id),
            load = f.store.load
        f.store.load = () => {
            throw Error('history must not clone the player profile')
        }
        for (let i = 0; i < 100; i++) {
            assert.deepEqual(history(f, f.a, f.b).chats, [])
            f.call(f.a, 'ChatSyncNew', { pids: [f.b.id, f.c.id] })
        }
        assert.equal(f.store.readCacheToken(f.a.id), token)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before)
        f.store.load = load
        f.send(f.a, f.b, 'outgoing after clear')
        assert.equal(chatSnapshots(f.store, f.state(f.a), f.a.id).list.info.length, 1)
        assert.equal(history(f, f.a, f.b).chats.length, 1)
        assert.equal(history(f, f.b, f.a).chats.length, 2)
    } finally {
        f.store.close()
    }
})
