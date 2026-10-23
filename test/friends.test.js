import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
import { chatRoutingInfo } from '../src/chat-shields.js'

const tables = new Tables(configuration().tables)
function fixture(filename = ':memory:') {
    const store = new Store(filename),
        protocol = new Protocol(configuration().base),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        sessions = Array.from({ length: 4 }, () => ({}))
    let seq = 1
    const call = (id, name, value = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(sessions[id - 1], { id: e.id, seq: seq++, payload: protocol.encode(e.req, value) })
    }
    for (let id = 1; id <= 4; id++) call(id, 'EnterGame', { open_id: 'friend-test-' + id })
    return {
        store,
        protocol,
        sessions,
        call,
        op: (id, optype, op, peer) => call(id, 'OpFriend', { optype, op, id: peer }),
        state: (id) => store.load(id).state,
        edit: (id, fn, options) => store.transact(id, 0, fn, options),
        sync: (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
    }
}
const code = (expected) => (error) => error.code === expected
test('6231 exact runtime friend application stores an incoming request for player4 and emits a recipient6233 alongside its empty ACK', () => {
    const f = fixture()
    try {
        const packets = f.op(1, 2, 1, 4),
            notice = packets.find((p) => p.id === 6233)
        assert.equal(notice.recipient, 4)
        assert.deepEqual(f.sync(notice), { datalist: [{ friendItem: { id: 1, time: '1800000000' }, type: 4 }] })
        assert.deepEqual(f.sync(packets.find((p) => p.id === 6231)), {})
        assert.equal(f.state(4).friendApplications[1], '1800000000')
        assert.equal(f.state(1).friendApplications, undefined)
        assert.deepEqual(f.state(1).friends ?? [], [])
        assert.deepEqual(f.state(4).friends ?? [], [])
        assert.throws(() => f.op(1, 2, 1, 4), code(ErrorCode.TargetGetYourApply))
        assert.equal(Object.keys(f.state(4).friendApplications).length, 1)
    } finally {
        f.store.close()
    }
})
test('6231 acceptance and removal update both actual friend lists; relogin6230 restores the same relation', () => {
    const f = fixture()
    try {
        f.op(1, 2, 1, 4)
        const packets = f.op(4, 1, 1, 1)
        assert.deepEqual(f.state(1).friends, [4])
        assert.deepEqual(f.state(4).friends, [1])
        assert.deepEqual(f.state(4).friendApplications, {})
        const deltas = packets.filter((p) => p.id === 6233)
        assert.equal(deltas.length, 2)
        assert.ok(deltas.some((p) => p.recipient === 1 && f.sync(p).datalist[0].type === 33))
        assert.throws(() => f.op(1, 2, 1, 4), code(ErrorCode.HadFriend))
        f.sessions[0] = {}
        const login = f.call(1, 'EnterGame', { open_id: 'friend-test-1' })
        assert.deepEqual(f.sync(login.find((p) => p.id === 6230)).info.friends, [{ id: 4, time: '1800000000' }])
        f.op(1, 1, 2, 4)
        assert.deepEqual(f.state(1).friends, [])
        assert.deepEqual(f.state(4).friends, [])
        assert.throws(() => f.op(4, 1, 1, 1), code(ErrorCode.FriendOpIsFail))
    } finally {
        f.store.close()
    }
})
test('6231 blacklist removes both friendships and pending applications and immediately feeds existing chat privacy routing', () => {
    const f = fixture()
    try {
        f.op(1, 2, 1, 4)
        f.op(4, 1, 1, 1)
        const old = chatRoutingInfo(f.store, 1)
        f.op(1, 3, 1, 4)
        assert.deepEqual(f.state(1).friends, [])
        assert.deepEqual(f.state(4).friends, [])
        assert.ok(chatRoutingInfo(f.store, 1).bans.has(4))
        assert.notEqual(chatRoutingInfo(f.store, 1).token, old.token)
        const message = (peer) => ({
            target: { chat_type: 0, tid: String(peer) },
            msg: Buffer.from('hi').toString('base64'),
            type: 0,
        })
        assert.throws(() => f.call(1, 'AddChat', message(4)), code(ErrorCode.YouBanTarget))
        assert.throws(() => f.call(4, 'AddChat', message(1)), code(ErrorCode.TargetBanYou))
        assert.throws(() => f.op(4, 2, 1, 1), code(ErrorCode.TargetBanYou))
        assert.throws(() => f.op(1, 2, 1, 4), code(ErrorCode.YouBanTarget))
        f.op(1, 3, 2, 4)
        assert.deepEqual(f.state(1).blockedPlayers, [])
        assert.equal(f.state(1).chatShields, undefined, 'friend blacklist is separate from chat-only mute')
        f.op(4, 2, 1, 1)
        f.op(1, 2, 2, 4)
        assert.deepEqual(f.state(1).friendApplications, {})
    } finally {
        f.store.close()
    }
})
test('6231 configured100/20/10 limits, self/unknown target, malformed operation and absent incoming requests reject without relationship changes', () => {
    const f = fixture()
    try {
        assert.throws(() => f.op(1, 2, 1, 1), code(ErrorCode.CannotOptYourSelf))
        assert.throws(() => f.op(1, 2, 1, 999999), code(ErrorCode.InvalidTarget))
        assert.throws(() => f.op(1, 0, 1, 4), code(ErrorCode.FriendOpIsFail))
        assert.throws(() => f.op(1, 1, 1, 4), code(ErrorCode.FriendOpIsFail))
        assert.throws(() => f.op(1, 3, 3, 0xffffffff), code(ErrorCode.FriendOpIsFail))
        f.edit(1, (s) => {
            s.friends = Array.from({ length: 100 }, (_, i) => i + 100)
        })
        assert.throws(() => f.op(1, 2, 1, 4), code(ErrorCode.FriendNumMax))
        f.edit(1, (s) => {
            s.friends = []
            s.blockedPlayers = Array.from({ length: 10 }, (_, i) => i + 100)
        })
        assert.throws(() => f.op(1, 3, 1, 4), code(ErrorCode.BanNumMax))
        f.edit(4, (s) => {
            s.friendApplications = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 100, '100']))
        })
        assert.throws(() => f.op(1, 2, 1, 4), code(ErrorCode.TargetFriendApplyNumMax))
        assert.equal(Object.keys(f.state(4).friendApplications).length, 20)
    } finally {
        f.store.close()
    }
})
test('6231 client batch sentinel supports atomic approval and all-reject; a blocked candidate never leaves earlier candidates partially accepted', () => {
    const f = fixture()
    try {
        f.op(2, 2, 1, 1)
        f.op(3, 2, 1, 1)
        f.edit(3, (s) => {
            s.blockedPlayers = [1]
        })
        assert.throws(() => f.op(1, 1, 3, 0xffffffff), code(ErrorCode.TargetBanYou))
        assert.deepEqual(f.state(2).friends ?? [], [])
        assert.equal(Object.keys(f.state(1).friendApplications).length, 2)
        f.edit(3, (s) => {
            s.blockedPlayers = []
        })
        f.op(1, 1, 3, 0xffffffff)
        assert.deepEqual(f.state(1).friends, [2, 3])
        assert.deepEqual(f.state(2).friends, [1])
        assert.deepEqual(f.state(3).friends, [1])
        f.op(4, 2, 1, 1)
        const packets = f.op(1, 2, 4, 0xffffffff)
        assert.deepEqual(f.state(1).friendApplications, {})
        assert.equal(f.sync(packets.find((p) => p.id === 6233)).datalist[0].type, 64)
    } finally {
        f.store.close()
    }
})
test('6231 notification and late ACK codec failures preserve both pending movement drafts, database rows, cache tokens and logs', () => {
    const f = fixture()
    try {
        for (const target of ['cs.SCFriendIncChange', 'cs.ProtoNullRsp']) {
            f.edit(
                1,
                (s) => {
                    s.world.pos.x = 111
                },
                { defer: true },
            )
            f.edit(
                4,
                (s) => {
                    s.world.pos.x = 444
                },
                { defer: true },
            )
            const before = [f.state(1), f.state(4)],
                pending = [f.store.pending.get(1), f.store.pending.get(4)],
                saved = f.store.db.prepare('SELECT * FROM players WHERE account_id IN(1,4)').all(),
                count = f.store.db.prepare('SELECT count(*) n FROM request_log').get().n,
                old = f.protocol.encode
            f.protocol.encode = function (name, data) {
                if (name === target) throw Error('friend injected codec failure')
                return old.call(this, name, data)
            }
            try {
                assert.throws(() => f.op(1, 2, 1, 4), /friend injected codec failure/)
            } finally {
                f.protocol.encode = old
            }
            assert.deepEqual([f.state(1), f.state(4)], before)
            assert.equal(f.store.pending.get(1), pending[0])
            assert.equal(f.store.pending.get(4), pending[1])
            assert.deepEqual(f.store.db.prepare('SELECT * FROM players WHERE account_id IN(1,4)').all(), saved)
            assert.equal(f.store.db.prepare('SELECT count(*) n FROM request_log').get().n, count)
        }
        f.op(1, 2, 1, 4)
        assert.equal(f.state(1).world.pos.x, 111)
        assert.equal(f.state(4).world.pos.x, 444)
        assert.equal(f.state(4).friendApplications[1], '1800000000')
        assert.equal(f.store.pending.has(1), false)
        assert.equal(f.store.pending.has(4), false)
    } finally {
        f.store.close()
    }
})
test('6231 peer SQL failure rolls back both rows without losing pending movement; closed SQLite restores applications and later friendship', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-friends-')),
        filename = path.join(dir, 'players.sqlite')
    let f
    try {
        f = fixture(filename)
        f.edit(
            4,
            (s) => {
                s.world.pos.z = 444
            },
            { defer: true },
        )
        const pending = f.store.pending.get(4),
            rows = f.store.db.prepare('SELECT * FROM players').all()
        f.store.db.exec(
            "CREATE TRIGGER fail_friend_peer BEFORE UPDATE ON players WHEN NEW.account_id=4 BEGIN SELECT RAISE(ABORT,'friend peer SQL failure'); END",
        )
        assert.throws(() => f.op(1, 2, 1, 4), /friend peer SQL failure/)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM players').all(), rows)
        assert.equal(f.store.pending.get(4), pending)
        f.store.db.exec('DROP TRIGGER fail_friend_peer')
        f.op(1, 2, 1, 4)
        f.store.close()
        f = fixture(filename)
        assert.equal(f.state(4).world.pos.z, 444)
        assert.equal(f.state(4).friendApplications[1], '1800000000')
        f.op(4, 1, 1, 1)
        f.store.close()
        f = fixture(filename)
        assert.deepEqual(f.state(1).friends, [4])
        assert.deepEqual(f.state(4).friends, [1])
    } finally {
        f?.store.close()
        // The task-created directory is the exact verified mkdtemp target.
        const resolved = path.resolve(dir),
            parent = path.resolve(os.tmpdir())
        assert.equal(path.dirname(resolved), parent)
        assert.ok(path.basename(resolved).startsWith('lurukaps-friends-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
test('damaged social data rejects friend operations as configuration damage while login omits only the social snapshot and records a diagnostic', () => {
    const f = fixture(),
        warn = console.warn,
        messages = []
    try {
        f.edit(1, (s) => {
            s.friends = ['not-a-player']
        })
        assert.throws(() => f.op(1, 2, 1, 4), code(ErrorCode.GameConfig))
        console.warn = (...args) => messages.push(args.join(' '))
        f.sessions[0] = {}
        const packets = f.call(1, 'EnterGame', { open_id: 'friend-test-1' })
        assert.ok(packets.some((p) => p.id === f.protocol.byName.get('CSProtoEnterGame').id))
        assert.ok(!packets.some((p) => p.id === 6230))
        assert.ok(messages.some((text) => text.startsWith('[friend-sync]')))
        assert.deepEqual(f.state(1).friends, ['not-a-player'])
    } finally {
        console.warn = warn
        f.store.close()
    }
})
