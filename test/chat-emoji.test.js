import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { chatEmojiSnapshot } from '../src/chat-emoji.js'
import { ErrorCode } from '../src/error-codes.js'

function sync(f, packets) {
    return f.reply(packets, 9942)
}

test('9941 replaces the complete ordered favorites and synchronizes every owned emoji before acknowledgement', () => {
    const f = chatShieldFixture('emoji-favorites')
    try {
        const other = structuredClone(f.state(f.b))
        const initial = chatEmojiSnapshot(f.tables, f.state(f.a))
        assert.equal(initial.bags.length, 28)
        assert.deepEqual(initial.collects, [])
        const packets = f.call(f.a, 'CollectChatEmojiChange', { u32s: [321, 101, 202] })
        assert(packets.findIndex((p) => p.id === 9942) < packets.findIndex((p) => p.id === 9941))
        assert.deepEqual(sync(f, packets), { ...initial, collects: [321, 101, 202], collect_dels: [] })
        assert.deepEqual(f.state(f.a).chatEmoji.collects, [321, 101, 202])
        assert.deepEqual(f.state(f.b), other)
        assert.deepEqual(sync(f, f.call(f.a, 'CollectChatEmojiChange', {})).collects, [])
        assert.deepEqual(f.state(f.a).chatShields, undefined)
    } finally {
        f.store.close()
    }
})

test('table capacity, duplicates, nonexistent and unowned emojis use their dedicated client codes without mutation', () => {
    const f = chatShieldFixture('emoji-validation')
    try {
        const ids = f.tables.get('chat_emoji').map((r) => r.id)
        assert.equal(Number(f.tables.get('game').find((r) => r.title === 'CHAT_EMOJI_COLLECT_NUM_MAX').value), 15)
        for (const [u32s, code] of [
            [ids.slice(0, 16), ErrorCode.CollectChatEmojiNumIsMax],
            [[101, 101], ErrorCode.ReqHasSameChatEmoji],
            [[0xffffffff], ErrorCode.ChatEmojiConfigNotExist],
            [[0], ErrorCode.InvalidArgument],
        ]) {
            const before = structuredClone(f.state(f.a))
            assert.throws(
                () => f.call(f.a, 'CollectChatEmojiChange', { u32s }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(f.a), before)
        }
        // Exercise a valid nondefault table row without granting it to either synthetic account.
        f.tables.find('chat_emoji', 101).isDefault = 0
        assert.throws(
            () => f.call(f.a, 'CollectChatEmojiChange', { u32s: [101] }),
            (e) => e.code === ErrorCode.ChatEmojiHadNot,
        )
        f.store.transact(f.a.id, 0, (s) => {
            s.chatEmoji = { unlocked: [101], recent: [101] }
        })
        const data = sync(f, f.call(f.a, 'CollectChatEmojiChange', { u32s: [101] }))
        assert.deepEqual(data.collects, [101])
        assert.deepEqual(data.lately_collects, [101])
        assert(data.bags.some((r) => r.id === 101))
        assert(!chatEmojiSnapshot(f.tables, f.state(f.b)).bags.some((r) => r.id === 101))
    } finally {
        f.store.close()
    }
})

test('9941 uses the actual table limit and rejects broken server configuration separately', () => {
    const f = chatShieldFixture('emoji-configuration')
    try {
        const row = f.tables.get('game').find((r) => r.title === 'CHAT_EMOJI_COLLECT_NUM_MAX')
        row.value = '1'
        assert.throws(
            () => f.call(f.a, 'CollectChatEmojiChange', { u32s: [101, 102] }),
            (e) => e.code === ErrorCode.CollectChatEmojiNumIsMax,
        )
        row.value = ''
        assert.throws(
            () => f.call(f.a, 'CollectChatEmojiChange', { u32s: [101] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        row.value = '15'
        f.store.transact(f.a.id, 0, (s) => {
            s.chatEmoji = { collects: [0xffffffff] }
        })
        assert.throws(
            () => f.call(f.a, 'CollectChatEmojiChange', {}),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('real 9942 and acknowledgement codec failures roll back the favorites and do not affect other users', () => {
    const f = chatShieldFixture('emoji-codec'),
        encode = f.protocol.encode
    try {
        for (const type of ['cs.AllChatEmojiInfo', 'cs.ProtoNullRsp']) {
            const before = structuredClone(f.state(f.a)),
                token = f.store.readCacheToken(f.a.id)
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('emoji codec failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call(f.a, 'CollectChatEmojiChange', { u32s: [101] }), /emoji codec failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.equal(f.store.readCacheToken(f.a.id), token)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('favorites survive actual SQLite close/reopen and are delivered by the login snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-chat-emoji-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = chatShieldFixture('emoji-reopen', file)
        f.call(f.a, 'CollectChatEmojiChange', { u32s: [202, 101] })
        f.store.close()
        f = chatShieldFixture('emoji-reopen', file)
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-emoji-reopen-a' })
        assert.deepEqual(sync(f, packets).collects, [202, 101])
        assert.equal(sync(f, packets).bags.length, 28)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-chat-emoji-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
