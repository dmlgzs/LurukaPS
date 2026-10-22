import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { chatBubbleSnapshot } from '../src/chat-cosmetics.js'
import { ErrorCode } from '../src/error-codes.js'

const sync = (f, packets) => f.reply(packets, 9949)
function addNondefault(f) {
    f.tables.get('chat_bubble').push({ ...f.tables.get('chat_bubble')[0], id: 20101, isDefault: 0, sort: 2 })
}

test('9950 selects the actual default bubble and synchronizes current/owned data before acknowledgement', () => {
    const f = chatShieldFixture('bubble-default')
    try {
        const other = structuredClone(f.state(f.b))
        assert.deepEqual(chatBubbleSnapshot(f.tables, f.state(f.a)), { use_bubble: 10101, unlock_bubble: [10101] })
        const packets = f.call(f.a, 'ChatBubbleChangeReq', { u32: 10101 })
        assert.deepEqual(sync(f, packets), { use_bubble: 10101, unlock_bubble: [10101] })
        assert(packets.findIndex((p) => p.id === 9949) < packets.findIndex((p) => p.id === 9950))
        assert.equal(f.state(f.a).chatBubble.use, 10101)
        assert.deepEqual(f.state(f.b), other)
        assert.equal(f.state(f.a).chatBackground, undefined)
        assert.deepEqual(sync(f, f.call({}, 'EnterGame', { open_id: 'shield-bubble-default-a' })), {
            use_bubble: 10101,
            unlock_bubble: [10101],
        })
    } finally {
        f.store.close()
    }
})

test('unavailable bubbles are rejected without granting unlocks or mutating account state', () => {
    const f = chatShieldFixture('bubble-locked')
    try {
        addNondefault(f)
        for (const [id, code] of [
            [0, ErrorCode.InvalidArgument],
            [20101, ErrorCode.ChatBubbleNotOpen],
            [0xffffffff, ErrorCode.ChatBubbleNotOpen],
        ]) {
            const before = structuredClone(f.state(f.a))
            assert.throws(
                () => f.call(f.a, 'ChatBubbleChangeReq', { u32: id }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(f.a), before)
        }
        f.store.transact(f.a.id, 0, (s) => {
            s.chatBubble = { unlocked: [20101] }
        })
        assert.deepEqual(sync(f, f.call(f.a, 'ChatBubbleChangeReq', { u32: 20101 })), {
            use_bubble: 20101,
            unlock_bubble: [10101, 20101],
        })
        assert.deepEqual(chatBubbleSnapshot(f.tables, f.state(f.b)).unlock_bubble, [10101])
    } finally {
        f.store.close()
    }
})

test('new messages and persisted history use the selected server bubble and reject forged unlocks', () => {
    const f = chatShieldFixture('bubble-messages')
    try {
        addNondefault(f)
        const request = {
            target: { tid: String(f.b.id), chat_type: 0 },
            type: 0,
            msg: Buffer.from('cosmetic test').toString('base64'),
            bubbleId: 20101,
        }
        assert.throws(
            () => f.call(f.a, 'AddChat', request),
            (e) => e.code === ErrorCode.ChatBubbleNotOpen,
        )
        assert.equal(f.store.chatHistory(f.a.id, f.b.id).length, 0)
        f.store.transact(f.a.id, 0, (s) => {
            s.chatBubble = { unlocked: [20101] }
        })
        f.call(f.a, 'ChatBubbleChangeReq', { u32: 20101 })
        const messages = f.call(f.a, 'AddChat', { ...request, bubbleId: 10101 })
        const pushed = messages
            .filter((p) => p.id === 9932)
            .map((p) => f.protocol.decode('cs.SCChatInfoChange', p.payload))
        assert.equal(pushed.length, 2)
        assert(pushed.every((r) => r.chat.bubbleId === 20101))
        assert.equal(f.store.chatHistory(f.a.id, f.b.id)[0].bubbleId, 20101)
        f.call(f.a, 'ChatBubbleChangeReq', { u32: 10101 })
        f.send(f.a, f.b, 'after change')
        assert.deepEqual(
            f.store.chatHistory(f.a.id, f.b.id).map((r) => r.bubbleId),
            [20101, 10101],
        )
    } finally {
        f.store.close()
    }
})

test('broken cosmetic table and state are configuration errors; real sync/ack codec failures roll back', () => {
    const f = chatShieldFixture('bubble-codec'),
        encode = f.protocol.encode
    try {
        for (const type of ['cs.SCChatBubbleInfo', 'cs.ProtoNullRsp']) {
            const before = structuredClone(f.state(f.a)),
                token = f.store.readCacheToken(f.a.id)
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('bubble codec failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call(f.a, 'ChatBubbleChangeReq', { u32: 10101 }), /bubble codec failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.equal(f.store.readCacheToken(f.a.id), token)
            f.protocol.encode = encode
        }
        f.tables.find('chat_bubble', 10101).isDefault = 0
        assert.throws(
            () => f.call(f.a, 'ChatBubbleChangeReq', { u32: 10101 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        f.tables.find('chat_bubble', 10101).isDefault = 1
        f.store.transact(f.a.id, 0, (s) => {
            s.chatBubble = { use: 0xffffffff }
        })
        assert.throws(
            () => f.call(f.a, 'ChatBubbleChangeReq', { u32: 10101 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('selected bubble survives SQLite restart and login returns the same owned list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-chat-bubble-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = chatShieldFixture('bubble-reopen', file)
        f.call(f.a, 'ChatBubbleChangeReq', { u32: 10101 })
        f.store.close()
        f = chatShieldFixture('bubble-reopen', file)
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-bubble-reopen-a' })
        assert.deepEqual(sync(f, packets), { use_bubble: 10101, unlock_bubble: [10101] })
        assert.equal(f.state(f.a).chatBubble.use, 10101)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-chat-bubble-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
