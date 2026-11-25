import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const reply = (f, packets, name) => f.reply(packets, f.protocol.byName.get('CSProto' + name).id)
const counts = (f, packets) => {
    const id = f.protocol.byName.get('CSProtoChatMsgCntSync').id
    return packets
        .filter((p) => p.id === id)
        .map((p) => f.protocol.decode(f.protocol.byId.get(id).rsp, p.payload))
        .flatMap((data) => data.msg_list)
}
const read = (f, from, peer, extra = {}) => f.call(from, 'ReadFriendChat', { id: peer.id, ...extra })

test('current local conversation opening +9930 send +9943 history replace retired create/query requests', () => {
    const f = chatShieldFixture('chat-current-route')
    try {
        assert.equal(f.protocol.byName.has('CSProtoCreateFriendChat'), false)
        assert.equal(f.protocol.byName.has('CSProtoChatInfoSync'), false)
        const sent = f.send(f.a, f.b, 'current1.0 private message'),
            history = reply(f, f.call(f.b, 'ChatSyncNew', { pids: [f.a.id] }), 'ChatSyncNew')
        assert.equal(history.chat_infos[0].id, f.a.id)
        assert.equal(history.chat_infos[0].chats.length, 1)
        assert.equal(
            Buffer.from(history.chat_infos[0].chats[0].msg, 'base64').toString('utf8'),
            'current1.0 private message',
        )
        assert.ok(sent.some((p) => p.recipient === f.b.id))
        assert.equal(
            reply(f, f.call(f.c, 'ChatSyncNew', { pids: [f.a.id] }), 'ChatSyncNew').chat_infos[0].chats.length,
            0,
        )
    } finally {
        f.store.close()
    }
})

test('actual current Lua9935 vector omits order; it reads saved history only and future incoming messages stay unread', () => {
    const f = chatShieldFixture('chat-current-read')
    try {
        f.send(f.b, f.a, 'one')
        f.send(f.b, f.a, 'two')
        const last = f.store.chatHistory(f.a.id, f.b.id, 1).at(-1).order
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, 0), 2)
        const packets = read(f, f.a, f.b)
        assert.equal(f.state(f.a).chatReads[f.b.id], last)
        assert.equal(counts(f, packets).find((r) => r.id === f.b.id).cnt, 0)
        f.send(f.b, f.a, 'future')
        assert.equal(f.state(f.a).chatReads[f.b.id], last)
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, last), 1)
        read(f, f.a, f.b)
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, f.state(f.a).chatReads[f.b.id]), 0)
    } finally {
        f.store.close()
    }
})

test('explicit legacy order is still bounded and monotonic; zero is not converted to a future read', () => {
    const f = chatShieldFixture('chat-explicit-read')
    try {
        f.send(f.b, f.a, 'first')
        f.send(f.b, f.a, 'second')
        const rows = f.store.chatHistory(f.a.id, f.b.id),
            [first, last] = [rows[0].order, rows.at(-1).order]
        read(f, f.a, f.b, { order: 0 })
        assert.equal(f.state(f.a).chatReads[f.b.id], 0)
        read(f, f.a, f.b, { order: first })
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, first), 1)
        const before = f.state(f.a)
        assert.throws(
            () => read(f, f.a, f.b, { order: last + 1 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(f.a), before)
        read(f, f.a, f.b, { order: 0 })
        assert.equal(f.state(f.a).chatReads[f.b.id], first)
    } finally {
        f.store.close()
    }
})

test('unowned/unknown conversations are rejected without clearing another pair or writing state/logs', () => {
    const f = chatShieldFixture('chat-no-authority')
    try {
        f.send(f.b, f.a, 'private')
        const before = f.state(f.c),
            logs = f.store.db.prepare('SELECT * FROM request_log').all()
        assert.throws(
            () => read(f, f.c, f.b),
            (e) => e.code === ErrorCode.ChatNotFound,
        )
        assert.deepEqual(f.state(f.c), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM request_log').all(), logs)
        assert.equal(f.store.chatUnread(f.a.id, f.b.id, 0), 1)
        assert.throws(
            () => f.call(f.c, 'ReadFriendChat', { id: 0xffffffff }),
            (e) => e.code === ErrorCode.InvalidTarget,
        )
        assert.throws(
            () => read(f, f.c, f.c),
            (e) => e.code === ErrorCode.ChatNotFound,
        )
    } finally {
        f.store.close()
    }
})

test('read push or ACK codec failure rolls back the read marker and unread notification transaction', () => {
    const f = chatShieldFixture('chat-current-codec'),
        encode = f.protocol.encode
    try {
        f.send(f.b, f.a, 'unread')
        const before = f.state(f.a)
        for (const type of [f.protocol.byName.get('CSProtoChatMsgCntSync').rsp, 'cs.ProtoNullRsp']) {
            f.protocol.encode = function (name, value) {
                if (name === type) throw Error('chat-read-codec')
                return encode.call(this, name, value)
            }
            assert.throws(() => read(f, f.a, f.b), /chat-read-codec/)
            assert.deepEqual(f.state(f.a), before)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('offline messages and read red-dot state survive real SQLite reopen and new EnterGame', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-chat-current-')),
        filename = path.join(directory, 'state.sqlite')
    let f = chatShieldFixture('chat-offline-read', filename)
    try {
        f.send(f.b, f.a, 'offline before reopen')
        const aid = f.a.id,
            bid = f.b.id
        f.store.close()
        f = chatShieldFixture('chat-offline-read', filename)
        assert.equal(f.store.chatUnread(aid, bid, f.state(f.a).chatReads?.[bid] ?? 0), 1)
        read(f, f.a, f.b)
        const readOrder = f.state(f.a).chatReads[bid]
        f.store.close()
        f = chatShieldFixture('chat-offline-read', filename)
        const login = f.call({}, 'EnterGame', { open_id: 'shield-chat-offline-read-a' })
        assert.equal(counts(f, login).find((r) => r.id === bid).cnt, 0)
        assert.equal(f.state(f.a).chatReads[bid], readOrder)
        f.send(f.b, f.a, 'later new incoming')
        assert.equal(f.store.chatUnread(aid, bid, readOrder), 1)
    } finally {
        f.store.close()
        const resolved = fs.realpathSync(directory)
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
        assert.ok(path.basename(resolved).startsWith('lurukaps-chat-current-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
