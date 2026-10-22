import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { startServer } from '../src/server.js'
import { FrameReader, encodeFrame } from '../src/wire.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables),
    bytes = (s) => Buffer.from(s).toString('base64')
function call(game, session, name, r = {}) {
    const e = protocol.byName.get('CSProto' + name)
    return game
        .dispatch(session, { id: e.id, seq: 1, payload: protocol.encode(e.req, r) })
        .map((p) => ({ ...p, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
}
test('private chat persists across restart, preserves read markers and separates conversations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azur-chat-'))
    let store = new Store(path.join(dir, 'state.sqlite'))
    try {
        let game = new Game(protocol, store, tables),
            a = {},
            b = {},
            c = {}
        for (const [s, id] of [
            [a, 'chat-a'],
            [b, 'chat-b'],
            [c, 'chat-c'],
        ])
            call(game, s, 'EnterGame', { open_id: id })
        const output = call(game, a, 'AddChat', {
            target: { tid: String(b.id), chat_type: 0 },
            msg: bytes('你好'),
            type: 0,
            time: 1,
        })
        const delivery = output.find((p) => p.id === 9932 && p.recipient === b.id)
        assert.equal(delivery.data.target.tid, String(a.id))
        assert.equal(delivery.data.chat.player_id, a.id)
        assert(delivery.data.chat.time > 1)
        assert.equal(delivery.data.chat.basic_info.account, undefined)
        assert.equal(delivery.data.chat.basic_info.gold, undefined)
        assert.equal(call(game, c, 'ChatInfoSync', { id: b.id })[0].data.chats.length, 0)
        const history = call(game, b, 'ChatInfoSync', { id: a.id })[0].data
        assert.equal(history.chats.length, 1)
        assert.equal(history.chats[0].msg, bytes('你好'))
        call(game, b, 'ReadFriendChat', { id: a.id, order: history.chats[0].order })
        assert.equal(store.chatUnread(b.id, a.id, history.chats[0].order), 0)
        const aid = a.id
        store.close()
        store = new Store(path.join(dir, 'state.sqlite'))
        game = new Game(protocol, store, tables)
        b = {}
        const login = call(game, b, 'EnterGame', { open_id: 'chat-b' })
        assert.equal(login.find((p) => p.id === 9930).data.info[0].chats.length, 1)
        assert.equal(login.find((p) => p.id === 9929).data.msg_list[0].cnt, 0)
        assert.equal(call(game, b, 'ChatInfoSync', { id: aid })[0].data.read_order, history.chats[0].order)
    } finally {
        store.close()
        assert(dir.startsWith(path.join(os.tmpdir(), 'azur-chat-')))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('invalid, blocked, and unauthorized group messages roll back without inserting chat rows', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        a = {},
        b = {}
    try {
        call(game, a, 'EnterGame', { open_id: 'reject-a' })
        call(game, b, 'EnterGame', { open_id: 'reject-b' })
        store.transact(b.id, 0, (s) => {
            s.blockedPlayers = [a.id]
        })
        const before = store.load(a.id)
        for (const request of [
            { target: { tid: String(b.id), chat_type: 0 }, msg: bytes('blocked') },
            { target: { tid: '999', chat_type: 0 }, msg: bytes('unknown') },
            { target: { tid: '1', chat_type: 1 }, msg: bytes('not-member') },
            { target: { tid: String(a.id), chat_type: 0 }, msg: bytes('  ') },
        ])
            assert.throws(() => call(game, a, 'AddChat', request))
        assert.equal(store.db.prepare('SELECT count(*) n FROM chat_messages').get().n, 0)
        assert.deepEqual(store.load(a.id), before)
    } finally {
        store.close()
    }
})
test('TCP routes private/encrypted and scoped public pushes, exact retry does not redeliver', async () => {
    const server = await startServer(
            { ...config, gamePort: 0, httpPort: 0, database: ':memory:', strongEncryption: true },
            { warn: () => {} },
        ),
        clients = []
    function client() {
        const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
            reader = new FrameReader(),
            queue = []
        let key,
            wake,
            seq = 1
        const c = {
            socket,
            queue,
            async response(id) {
                const end = Date.now() + 5000
                while (Date.now() < end) {
                    const i = queue.findIndex((f) => f.id === id)
                    if (i >= 0) return queue.splice(i, 1)[0]
                    await new Promise((resolve) => {
                        const t = setTimeout(resolve, 50)
                        wake = () => {
                            clearTimeout(t)
                            resolve()
                        }
                    })
                }
                throw Error('Missing ' + id)
            },
            send(name, r = {}) {
                const e = server.protocol.byName.get('CSProto' + name),
                    packet = encodeFrame(
                        { id: e.id, seq: seq++, flag: key && e.id !== 5001 ? 2 : 0 },
                        server.protocol.encode(e.req, r),
                        { encryptionKey: key },
                    )
                socket.write(packet)
                return packet
            },
        }
        socket.on('data', (chunk) => {
            reader.feed(chunk, (f) => {
                if (f.id === 5014) {
                    key = Buffer.from(server.protocol.decode('SCEnterGameToken', f.payload).rc4_key, 'base64')
                    reader.setEncryptionKey(key)
                }
                queue.push(f)
            })
            wake?.()
        })
        clients.push(c)
        return c
    }
    try {
        const a = client(),
            b = client(),
            c = client()
        await Promise.all(clients.map((x) => once(x.socket, 'connect')))
        for (const [client, name] of [
            [a, 'tcp-chat-a'],
            [b, 'tcp-chat-b'],
            [c, 'tcp-chat-c'],
        ]) {
            client.send('EnterGame', { open_id: name })
            client.pid = server.protocol.decode('SCEnterGame', (await client.response(5001)).payload).player_id
        }
        const original = a.send('AddChat', {
            target: { tid: String(b.pid), chat_type: 0 },
            msg: bytes('private'),
            type: 0,
        })
        await a.response(9933)
        const direct = await b.response(9932)
        assert.equal(direct.flag, 2)
        assert.equal(server.protocol.decode('SCChatInfoChange', direct.payload).chat.msg, bytes('private'))
        await a.response(9932)
        a.socket.write(original)
        await a.response(9933)
        await a.response(9932)
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.equal(b.queue.filter((f) => f.id === 9932).length, 0)
        assert.equal(c.queue.filter((f) => f.id === 9932).length, 0)
        assert.equal(server.store.db.prepare('SELECT count(*) n FROM chat_messages').get().n, 1)
        server.store.transact(c.pid, 0, (s) => {
            s.chatWorldRoom = 2
            s.world.map_id = 101
        })
        a.send('AddChat', { target: { chat_type: 2, tid: '1' }, msg: bytes('world') })
        await a.response(9933)
        await a.response(9932)
        assert.equal(server.protocol.decode('SCChatInfoChange', (await b.response(9932)).payload).target.chat_type, 2)
        a.send('AddChat', { target: { chat_type: 3 }, msg: bytes('map') })
        await a.response(9933)
        await a.response(9932)
        assert.equal(server.protocol.decode('SCChatInfoChange', (await b.response(9932)).payload).target.chat_type, 3)
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.equal(c.queue.filter((f) => f.id === 9932).length, 0)
        b.send('ChatShieldOp', { tar_id: a.pid, op: 1 })
        await b.response(9947)
        b.send('ChatGetShieldList')
        assert.deepEqual(
            server.protocol.decode('SCChatGetShieldList', (await b.response(9948)).payload).items.map((r) => r.pid),
            [a.pid],
        )
        a.send('AddChat', { target: { chat_type: 0, tid: String(b.pid) }, msg: bytes('muted-private') })
        await a.response(9933)
        await a.response(9932)
        a.send('AddChat', { target: { chat_type: 2, tid: '1' }, msg: bytes('muted-world') })
        await a.response(9933)
        await a.response(9932)
        b.send('Ping', { client_ts: '900' })
        await b.response(503)
        assert.equal(
            b.queue.filter(
                (f) => f.id === 9932 && server.protocol.decode('SCChatInfoChange', f.payload).chat.player_id === a.pid,
            ).length,
            0,
        )
        // Chat mutes must not suppress unrelated encrypted gameplay broadcasts.
        const pet = server.store.load(a.pid).state.pets[0].guid,
            action = a.send('SwitchPetAction', { uuid: pet, type: 1 })
        const remote = await b.response(11062)
        assert.equal(remote.flag, 2)
        assert.equal(server.protocol.decode('SwitchPetAction', remote.payload).uuid, pet)
        a.socket.write(action)
        a.send('Ping', { client_ts: '99' })
        await a.response(503)
        assert.equal(a.queue.filter((f) => f.id === 11062 || f.id === 11061).length, 0)
        assert.equal(b.queue.filter((f) => f.id === 11062).length, 0)
        assert.equal(c.queue.filter((f) => f.id === 11062).length, 0)
        b.send('ChatShieldOp', { tar_id: a.pid, op: 2 })
        await b.response(9947)
        b.send('ChatGetShieldList')
        assert.deepEqual(server.protocol.decode('SCChatGetShieldList', (await b.response(9948)).payload).items, [])
        a.send('AddChat', { target: { chat_type: 2, tid: '1' }, msg: bytes('unmuted-world') })
        await a.response(9933)
        await a.response(9932)
        assert.equal(
            server.protocol.decode('SCChatInfoChange', (await b.response(9932)).payload).chat.msg,
            bytes('unmuted-world'),
        )
    } finally {
        for (const c of clients) c.socket.destroy()
        await server.close()
    }
})

test('entry sends one Base64 server notice into each session world chat after its own timer', async () => {
    const server = await startServer(
            {
                ...config,
                gamePort: 0,
                httpPort: 0,
                database: ':memory:',
                strongEncryption: true,
                entryWorldChatNoticeDelayMs: 30,
            },
            { info: () => {}, warn: () => {} },
        ),
        clients = []
    function client() {
        const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
            reader = new FrameReader(),
            queue = []
        let key,
            wake,
            seq = 1
        const c = {
            socket,
            queue,
            async response(id) {
                const end = Date.now() + 5000
                while (Date.now() < end) {
                    const i = queue.findIndex((frame) => frame.id === id)
                    if (i >= 0) return queue.splice(i, 1)[0]
                    await new Promise((resolve) => {
                        const timer = setTimeout(resolve, 25)
                        wake = () => {
                            clearTimeout(timer)
                            resolve()
                        }
                    })
                }
                throw Error(`Missing ${id}`)
            },
            send(name, request = {}) {
                const e = server.protocol.byName.get(`CSProto${name}`)
                socket.write(
                    encodeFrame(
                        { id: e.id, seq: seq++, flag: key && e.id !== 5001 ? 2 : 0 },
                        server.protocol.encode(e.req, request),
                        { encryptionKey: key },
                    ),
                )
            },
        }
        socket.on('data', (chunk) => {
            reader.feed(chunk, (frame) => {
                if (frame.id === 5014) {
                    key = Buffer.from(server.protocol.decode('SCEnterGameToken', frame.payload).rc4_key, 'base64')
                    reader.setEncryptionKey(key)
                }
                queue.push(frame)
            })
            wake?.()
        })
        clients.push(c)
        return c
    }
    try {
        const a = client(),
            b = client()
        await Promise.all(clients.map((x) => once(x.socket, 'connect')))
        a.send('EnterGame', { open_id: 'entry-chat-a' })
        await a.response(5001)
        await new Promise((resolve) => setTimeout(resolve, 10))
        b.send('EnterGame', { open_id: 'entry-chat-b' })
        await b.response(5001)

        const [noticeA, noticeB] = await Promise.all([a.response(9932), b.response(9932)]),
            decodedA = server.protocol.decode('SCChatInfoChange', noticeA.payload),
            decodedB = server.protocol.decode('SCChatInfoChange', noticeB.payload)
        for (const decoded of [decodedA, decodedB]) {
            assert.equal(decoded.target.chat_type, 2)
            assert.equal(decoded.target.tid, '1')
            assert.equal(
                decoded.chat.msg,
                'THVydWthUFMg5piv55So5LqO5a2m5Lmg56CU56m25Y2P6K6u5a6e546w55qE5YWN6LS55byA5rqQ6L2v5Lu244CC5aaC5p6c5L2g5piv5LuY6LS56LSt5Lmw55qE77yM6YKj5L2g5bey57uP6KKr6aqX5LqG44CCTHVydWthUFMgaXMgZnJlZSBhbmQgb3Blbi1zb3VyY2Ugc29mdHdhcmUgaW50ZW5kZWQgZm9yIGxlYXJuaW5nIGFuZCBwcm90b2NvbCByZXNlYXJjaC4gSWYgeW91IHBhaWQgZm9yIGl0LCB5b3UgaGF2ZSBiZWVuIHNjYW1tZWQuIEdpdEh1YjogaHR0cHM6Ly9naXRodWIuY29tL2RtbGd6cy9MdXJ1a2FQUw==',
            )
            assert.equal(decoded.chat.player_id, 0)
            assert.equal(decoded.chat.basic_info.stand_plates.profile, 10114)
            assert.equal(decoded.chat.basic_info.stand_plates.profile_frame, 10231)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(a.queue.filter((frame) => frame.id === 9932).length, 0)
        assert.equal(b.queue.filter((frame) => frame.id === 9932).length, 0)
    } finally {
        for (const c of clients) c.socket.destroy()
        await server.close()
    }
})

test('schema2 upgrades chat storage and outgoing encode failure rolls back inserted messages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azur-chat-'))
    let store = new Store(path.join(dir, 'state.sqlite'))
    try {
        let game = new Game(protocol, store, tables),
            a = {},
            b = {}
        call(game, a, 'EnterGame', { open_id: 'migrate-chat-a' })
        call(game, b, 'EnterGame', { open_id: 'migrate-chat-b' })
        const before = store.load(a.id)
        store.db.exec('DROP TABLE chat_messages; PRAGMA user_version=2')
        store.close()
        store = new Store(path.join(dir, 'state.sqlite'))
        assert.equal(store.db.pragma('user_version', { simple: true }), 3)
        assert.deepEqual(store.load(a.id), before)
        game = new Game(protocol, store, tables)
        store.transact(a.id, 0, (s) => {
            s.player.basic_info.wardrobe.invalid_test_field = true
        })
        const state = store.load(a.id)
        assert.throws(
            () =>
                call(game, a, 'AddChat', { target: { tid: String(b.id), chat_type: 0 }, msg: bytes('must rollback') }),
            /Unknown field/,
        )
        assert.equal(store.db.prepare('SELECT count(*) n FROM chat_messages').get().n, 0)
        assert.deepEqual(store.load(a.id), state)
    } finally {
        store.close()
        assert(dir.startsWith(path.join(os.tmpdir(), 'azur-chat-')))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('world chat room discovery, joining and relog reflect persisted routing membership', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        a = {},
        b = {}
    try {
        call(game, a, 'EnterGame', { open_id: 'room-a' })
        call(game, b, 'EnterGame', { open_id: 'room-b' })
        assert.equal(call(game, a, 'ChatRoomNum', { chat_type: 2 })[0].data.count, 1)
        call(game, b, 'AddChat', { target: { tid: '3', chat_type: 2 }, msg: bytes('room three') })
        assert.equal(call(game, a, 'ChatRoomNum', { chat_type: 2 })[0].data.count, 3)
        const output = call(game, a, 'ChatWorldJoin', { sysId: '3' })
        assert.equal(output[0].id, 9944)
        assert.equal(output[0].data.sysId, '3')
        assert.equal(store.load(a.id).state.chatWorldRoom, 3)
        const sent = call(game, a, 'AddChat', { target: { chat_type: 2 }, msg: bytes('current room') })
        assert.equal(sent.find((p) => p.id === 9932).data.target.tid, '3')
        const sentinel = call(game, a, 'AddChat', {
            target: { tid: '18446744073709551615', chat_type: 2 },
            msg: bytes('default room sentinel'),
        })
        assert.equal(sentinel.find((p) => p.id === 9932).data.target.tid, '3')
        assert.throws(() =>
            call(game, a, 'AddChat', {
                target: { tid: '18446744073709551615', chat_type: 0 },
                msg: bytes('invalid private peer'),
            }),
        )
        const login = call(game, {}, 'EnterGame', { open_id: 'room-a' })
        assert.equal(login.find((p) => p.id === 9944).data.sysId, '3')
        const before = store.load(a.id)
        for (const sysId of ['0', '4', '9007199254740993'])
            assert.throws(() => call(game, a, 'ChatWorldJoin', { sysId }))
        assert.deepEqual(store.load(a.id), before)
    } finally {
        store.close()
    }
})

test('world slash commands use shared GM grants and never enter chat history or broadcast', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        a = {},
        b = {}
    try {
        call(game, a, 'EnterGame', { open_id: 'slash-a' })
        call(game, b, 'EnterGame', { open_id: 'slash-b' })
        const result = call(game, a, 'AddChat', {
            target: { chat_type: 2, tid: '18446744073709551615' },
            type: 0,
            msg: bytes('/item 300000 7'),
        })
        assert.equal(store.load(a.id).state.player.sbag_infos.items.find((i) => i.itemid === 300000).itemnum, 7)
        assert.equal(store.load(b.id).state.player.sbag_infos.items.length, 0)
        assert.equal(store.db.prepare('SELECT count(*) n FROM chat_messages').get().n, 0)
        assert(result.some((p) => p.id === 19903))
        assert(!result.some((p) => p.id === 9932 || p.audience || p.recipient))
        assert(result[0].data.sbag_infos.items.every((i) => BigInt(i.guid) > 0n))
        const before = store.load(a.id)
        assert.throws(() => call(game, a, 'AddChat', { target: { chat_type: 2 }, msg: bytes('/not-a-command') }))
        assert.deepEqual(store.load(a.id), before)
        const disabled = new Game(protocol, store, tables, { gmEnabled: false })
        assert.throws(
            () => call(disabled, a, 'AddChat', { target: { chat_type: 2 }, msg: bytes('/gold 100') }),
            /disabled/,
        )
        assert.deepEqual(store.load(a.id), before)
        call(game, a, 'AddChat', { target: { chat_type: 0, tid: String(b.id) }, msg: bytes('/gold 100') })
        assert.equal(store.load(a.id).state.player.basic_info.gold, 0)
        assert.equal(store.db.prepare('SELECT count(*) n FROM chat_messages').get().n, 1)
    } finally {
        store.close()
    }
})
