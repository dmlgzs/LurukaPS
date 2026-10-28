import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

const bytes = (value) => Buffer.from(value).toString('base64')
const request = (f, value, type = 2) => ({ target: { tid: String(f.b.id), chat_type: 0 }, type, msg: bytes(value) })
const send = (f, id) => f.call(f.a, 'AddChat', request(f, String(id)))
const recent = (f) => f.state(f.a).chatEmoji?.recent ?? []
const messages = (f) => f.store.db.prepare('SELECT * FROM chat_messages ORDER BY id').all()
function rejects(f, value, code) {
    const before = structuredClone(f.state(f.a)),
        chat = messages(f)
    assert.throws(
        () => f.call(f.a, 'AddChat', value),
        (error) => error.code === code,
    )
    assert.deepEqual(f.state(f.a), before)
    assert.deepEqual(messages(f), chat)
}

test('9933 accepted CHAT_EMOJI=2 persists the original message and sends owned/favorites/recent9942 to its owner before acknowledgement', () => {
    const f = chatShieldFixture('recent-owner')
    try {
        f.store.transact(f.a.id, 0, (state) => {
            state.chatEmoji = { unlocked: [101], collects: [202], recent: [103, 101] }
        })
        const other = structuredClone(f.state(f.b)),
            packets = send(f, 202),
            sync = f.reply(packets, 9942)
        assert.deepEqual(recent(f), [202, 103, 101])
        assert.deepEqual(f.state(f.a).chatEmoji.unlocked, [101])
        assert.deepEqual(sync.collects, [202])
        assert.equal(sync.bags.length, 28)
        assert.deepEqual(sync.lately_collects, [202, 103, 101])
        const localSync = packets.find((packet) => packet.id === 9942)
        assert.equal(localSync.recipient, undefined)
        assert(packets.findIndex((packet) => packet.id === 9942) < packets.findIndex((packet) => packet.id === 9933))
        const ownMessage = packets.find(
            (packet) => packet.id === f.protocol.byName.get('CSProtoChatInfoChange').id && !packet.recipient,
        )
        assert(packets.indexOf(localSync) < packets.indexOf(ownMessage))
        const data = f.protocol.decode(f.protocol.byId.get(ownMessage.id).rsp, ownMessage.payload)
        assert.equal(Buffer.from(data.chat.msg, 'base64').toString(), '202')
        assert.equal(data.chat.type, 2)
        assert.equal(messages(f).length, 1)
        assert.deepEqual(f.state(f.b), other)
    } finally {
        f.store.close()
    }
})

test('recent uses the actual20 cap and stable latest-use-first unique IDs across repeated accepted messages', () => {
    const f = chatShieldFixture('recent-cap')
    try {
        const ids = f.tables.get('chat_emoji').map((row) => row.id),
            cap = Number(f.tables.get('game').find((row) => row.title === 'CHAT_EMOJI_COLLECT_RECENTLY_NUM_MAX').value)
        assert.equal(cap, 20)
        for (const id of ids.slice(0, cap + 1)) send(f, id)
        const expected = ids
            .slice(0, cap + 1)
            .reverse()
            .slice(0, cap)
        assert.deepEqual(recent(f), expected)
        send(f, expected[8])
        const moved = [expected[8], ...expected.filter((id) => id !== expected[8])]
        assert.deepEqual(recent(f), moved)
        const count = messages(f).length
        send(f, expected[8])
        assert.deepEqual(recent(f), moved)
        assert.equal(
            messages(f).length,
            count + 1,
            'List deduplication must not suppress a genuine accepted chat message',
        )
    } finally {
        f.store.close()
    }
})

test('ordinary text and quick words keep prior behavior and never inspect or change unrelated legacy emoji state', () => {
    const f = chatShieldFixture('recent-other-types')
    try {
        f.store.transact(f.a.id, 0, (state) => {
            state.chatEmoji = { recent: [0] }
        })
        const before = structuredClone(f.state(f.a).chatEmoji)
        for (const [value, type] of [
            ['ordinary text', 0],
            ['101', 1],
        ]) {
            const packets = f.call(f.a, 'AddChat', request(f, value, type))
            assert(!packets.some((packet) => packet.id === 9942))
            assert.deepEqual(f.state(f.a).chatEmoji, before)
        }
        assert.equal(messages(f).length, 2)
    } finally {
        f.store.close()
    }
})

test('canonical byte payload, configuration, ownership and existing blacklist failures never append a message or recent entry', () => {
    const f = chatShieldFixture('recent-validation')
    try {
        for (const value of [
            '0',
            '0101',
            '+101',
            '-101',
            '1.01',
            '101\n',
            ' 101',
            '4294967296',
            '１０１',
            Buffer.from([0xb1, 0x30, 0x31]),
        ])
            rejects(f, request(f, value), ErrorCode.InvalidArgument)
        rejects(f, request(f, '4294967295'), ErrorCode.ChatEmojiConfigNotExist)
        f.tables.find('chat_emoji', 101).isDefault = 0 // Controlled nondefault table row; no synthetic unlock producer.
        rejects(f, request(f, '101'), ErrorCode.ChatEmojiHadNot)
        f.tables.find('chat_emoji', 101).isDefault = 1
        f.store.transact(f.b.id, 0, (state) => {
            state.blockedPlayers = [f.a.id]
        }) // Existing blocked-account fixture.
        rejects(f, request(f, '101'), ErrorCode.TargetBanYou)
    } finally {
        f.store.close()
    }
})

test('malformed recent capacity and managed emoji state reject only emoji sends atomically with GameConfig', () => {
    const f = chatShieldFixture('recent-corrupt')
    try {
        const config = f.tables.get('game').find((row) => row.title === 'CHAT_EMOJI_COLLECT_RECENTLY_NUM_MAX')
        for (const value of ['', '0', '1.5', '-1']) {
            config.value = value
            rejects(f, request(f, '101'), ErrorCode.GameConfig)
        }
        config.value = '20'
        f.store.transact(f.a.id, 0, (state) => {
            state.chatEmoji = { recent: [101, 101] }
        })
        rejects(f, request(f, '101'), ErrorCode.GameConfig)
    } finally {
        f.store.close()
    }
})

test('9942, message and9933 ACK codec faults plus late SQL failure roll back chat rows, recent, saved state and pending state together', () => {
    const f = chatShieldFixture('recent-atomic'),
        encode = f.protocol.encode
    try {
        f.store.transact(
            f.a.id,
            0,
            (state) => {
                state.chatRecentPendingMarker = 'pending'
            },
            { defer: true },
        )
        const before = structuredClone(f.state(f.a)),
            chat = messages(f),
            pending = f.store.pending.get(f.a.id)
        const sql = () => f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.a.id)
        const saved = sql()
        const unchanged = () => {
            assert.deepEqual(f.state(f.a), before)
            assert.deepEqual(messages(f), chat)
            assert.deepEqual(sql(), saved)
            assert.equal(f.store.pending.get(f.a.id), pending)
        }
        for (const type of ['CSProtoChatEmojiSync', 'CSProtoChatInfoChange', 'CSProtoAddChat'].map(
            (name) => f.protocol.byName.get(name).rsp,
        )) {
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('recent-codec-' + type)
                return encode.call(this, name, ...args)
            }
            assert.throws(() => send(f, 101), /recent-codec/)
            unchanged()
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER recent_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'recent-sql'); END",
        )
        assert.throws(() => send(f, 101), /recent-sql/)
        unchanged()
        f.store.db.exec('DROP TRIGGER recent_fail')
        send(f, 101)
        assert.deepEqual(recent(f), [101])
        assert.equal(messages(f).length, 1)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('actual SQLite reopen and login preserve successful recent history without replacing favorites or minting unlocks', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'chat-recent-b325-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = chatShieldFixture('recent-reopen', file)
        f.call(f.a, 'CollectChatEmojiChange', { u32s: [202, 101] })
        send(f, 101)
        send(f, 202)
        f.store.close()
        f = chatShieldFixture('recent-reopen', file)
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-recent-reopen-a' }),
            sync = f.reply(packets, 9942)
        assert.deepEqual(sync.lately_collects, [202, 101])
        assert.deepEqual(sync.collects, [202, 101])
        assert.equal(sync.bags.length, 28)
        assert.equal(f.state(f.a).chatEmoji.unlocked, undefined)
        assert.equal(messages(f).length, 2)
    } finally {
        f?.store.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), parent)
        assert(path.basename(resolved).startsWith('chat-recent-b325-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
