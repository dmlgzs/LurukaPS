import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { chatBackgroundSnapshot, chatBubbleSnapshot } from '../src/chat-cosmetics.js'
import { ErrorCode } from '../src/error-codes.js'

const sync = (f, packets) => f.reply(packets, 9951)
function addNondefault(f) {
    f.tables.get('chat_bg').push({ ...f.tables.get('chat_bg')[0], id: 20101, isDefault: 0, sort: 2 })
}

test('9952 selects the configured default background and pushes its actual wire fields before acknowledgement', () => {
    const f = chatShieldFixture('background-default')
    try {
        const other = structuredClone(f.state(f.b)),
            bubble = chatBubbleSnapshot(f.tables, f.state(f.a))
        const expected = { use_background: 10101, unlock_background: [10101] }
        assert.deepEqual(chatBackgroundSnapshot(f.tables, f.state(f.a)), expected)
        const packets = f.call(f.a, 'ChatBackgroundChangeReq', { u32: 10101 })
        assert.deepEqual(sync(f, packets), expected)
        assert(packets.findIndex((p) => p.id === 9951) < packets.findIndex((p) => p.id === 9952))
        assert.equal(f.state(f.a).chatBackground.use, 10101)
        assert.deepEqual(f.state(f.b), other)
        assert.deepEqual(chatBubbleSnapshot(f.tables, f.state(f.a)), bubble)
        assert.deepEqual(sync(f, f.call({}, 'EnterGame', { open_id: 'shield-background-default-a' })), expected)
    } finally {
        f.store.close()
    }
})

test('background unlocks are separate from bubble unlocks and cannot be forged by choosing an ID', () => {
    const f = chatShieldFixture('background-locked')
    try {
        addNondefault(f)
        f.tables.get('chat_bubble').push({ ...f.tables.get('chat_bubble')[0], id: 20101, isDefault: 0, sort: 2 })
        f.store.transact(f.a.id, 0, (s) => {
            s.chatBubble = { use: 20101, unlocked: [20101] }
        })
        for (const [id, code] of [
            [0, ErrorCode.InvalidArgument],
            [20101, ErrorCode.ChatBackgroundNotOpen],
            [0xffffffff, ErrorCode.ChatBackgroundNotOpen],
        ]) {
            const before = structuredClone(f.state(f.a))
            assert.throws(
                () => f.call(f.a, 'ChatBackgroundChangeReq', { u32: id }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(f.a), before)
        }
        f.store.transact(f.a.id, 0, (s) => {
            s.chatBackground = { unlocked: [20101] }
        })
        assert.deepEqual(sync(f, f.call(f.a, 'ChatBackgroundChangeReq', { u32: 20101 })), {
            use_background: 20101,
            unlock_background: [10101, 20101],
        })
        assert.deepEqual(chatBackgroundSnapshot(f.tables, f.state(f.b)).unlock_background, [10101])
        assert.equal(f.state(f.a).chatBubble.use, 20101)
    } finally {
        f.store.close()
    }
})

test('the chat background remains local to its account and never becomes chat content or a broadcast', () => {
    const f = chatShieldFixture('background-private')
    try {
        const packets = f.call(f.a, 'ChatBackgroundChangeReq', { u32: 10101 })
        assert(!packets.some((p) => p.recipient || p.audience || p.id === 9932))
        const sent = f.send(f.a, f.b, 'plain content')
        const data = f.protocol.decode('cs.SCChatInfoChange', sent.find((p) => p.id === 9932).payload)
        assert.equal(data.chat.backgroundId, undefined)
        assert.equal(data.chat.bubbleId, 10101)
        assert.equal(f.state(f.b).chatBackground, undefined)
    } finally {
        f.store.close()
    }
})

test('9951 and ACK codec failures roll back selection; damaged table/state remain configuration failures', () => {
    const f = chatShieldFixture('background-codec'),
        encode = f.protocol.encode
    try {
        for (const type of ['cs.SCChatBackgroundInfo', 'cs.ProtoNullRsp']) {
            const before = structuredClone(f.state(f.a)),
                token = f.store.readCacheToken(f.a.id)
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('background codec failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call(f.a, 'ChatBackgroundChangeReq', { u32: 10101 }), /background codec failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.equal(f.store.readCacheToken(f.a.id), token)
            f.protocol.encode = encode
        }
        f.tables.find('chat_bg', 10101).isDefault = 0
        assert.throws(
            () => f.call(f.a, 'ChatBackgroundChangeReq', { u32: 10101 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        f.tables.find('chat_bg', 10101).isDefault = 1
        f.store.transact(f.a.id, 0, (s) => {
            s.chatBackground = { unlocked: [10101, 10101] }
        })
        assert.throws(
            () => f.call(f.a, 'ChatBackgroundChangeReq', { u32: 10101 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('background selection is persisted and restored through SQLite and actual login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-chat-background-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = chatShieldFixture('background-reopen', file)
        f.call(f.a, 'ChatBackgroundChangeReq', { u32: 10101 })
        f.store.close()
        f = chatShieldFixture('background-reopen', file)
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-background-reopen-a' })
        assert.deepEqual(sync(f, packets), { use_background: 10101, unlock_background: [10101] })
        assert.equal(f.state(f.a).chatBackground.use, 10101)
        assert.equal(f.state(f.a).chatBubble, undefined)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-chat-background-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
