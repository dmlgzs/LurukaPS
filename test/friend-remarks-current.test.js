import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { validateFriendRemark } from '../src/friend-remarks.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    b64 = (t) => Buffer.from(t, 'utf8').toString('base64')
function fixture(file = ':memory:') {
    const store = new Store(file),
        protocol = new Protocol(cfg.base),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const sessions = [{}, {}, {}]
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) }
    }
    const dispatch = (id, r) => game.dispatch(sessions[id - 1], r)
    const call = (id, name, data) => dispatch(id, frame(name, data))
    const login = (id) => {
        sessions[id - 1] = {}
        return call(id, 'EnterGame', { open_id: 'remark-current-' + id })
    }
    for (let id = 1; id <= 3; id++) {
        login(id)
        // Independent trusted post-main checkpoint for the current friend17
        // menu; actual relations below still come only from6231, not fake IDs.
        const gate = tables.find('system_unlock', 17).unlockCondi.split('#').map(Number)
        assert.equal(gate[0], 12045)
        store.transact(id, 0, (s) => {
            s.taskRecords = [{ task_id: gate[1], count: 1 }]
            s.tasks = []
        })
        call(id, 'Ping', {})
    }
    if (!store.load(1).state.friends?.includes(2)) {
        call(1, 'OpFriend', { optype: 2, op: 1, id: 2 })
        call(2, 'OpFriend', { optype: 1, op: 1, id: 1 })
    }
    const state = (id) => store.load(id).state,
        saved = (id) => store.load(id),
        decode = (p) => protocol.decode(protocol.byId.get(p.id).rsp, p.payload)
    const note = (id, peer, text) => call(id, 'ChangeFriendRemark', { id: peer, remark: b64(text) })
    return {
        store,
        protocol,
        game,
        sessions,
        frame,
        dispatch,
        call,
        login,
        state,
        saved,
        decode,
        note,
        close: () => store.close(),
    }
}
function row(f, packets, id) {
    const p = packets.find((p) => p.id === 6230)
    assert(p)
    return f.decode(p).info.friends.find((r) => r.id === id)
}
test('current6232 owns private UTF8-byte remarks, allows empty clear, and cold6230 restores only the owner view', () => {
    const f = fixture()
    try {
        const other = f.saved(2),
            third = f.saved(3)
        const packets = f.note(1, 2, '常一起玩'),
            response = f.decode(packets.find((p) => p.id === 6232))
        assert.deepEqual(response, { id: 2, remark: b64('常一起玩') })
        assert(packets.every((p) => p.recipient === undefined || p.recipient === 1))
        assert.deepEqual(f.saved(2), other)
        assert.deepEqual(f.saved(3), third)
        assert.equal(row(f, f.login(1), 2).remark, b64('常一起玩'))
        assert.equal(row(f, f.login(2), 1).remark, undefined)
        f.note(2, 1, '队友甲')
        assert.equal(row(f, f.login(1), 2).remark, b64('常一起玩'))
        assert.equal(row(f, f.login(2), 1).remark, b64('队友甲'))
        const clear = f.note(1, 2, '')
        assert.equal(f.decode(clear.find((p) => p.id === 6232)).remark, '')
        assert.equal(row(f, f.login(1), 2).remark, '')
    } finally {
        f.close()
    }
})
test('current fullwidth14 admits seven Chinese/14ASCII and exact mixed widths, rejects malformed UTF8/nonwhite/overlong names atomically', () => {
    const f = fixture()
    try {
        for (const text of ['甲'.repeat(7), 'A'.repeat(14), '甲'.repeat(6) + 'Ab', 'Ａ'.repeat(7)]) {
            assert.equal(validateFriendRemark(tables, b64(text)), b64(text))
            f.note(1, 2, text)
        }
        for (const value of [
            b64('甲'.repeat(8)),
            b64('A'.repeat(15)),
            b64('甲'.repeat(7) + 'A'),
            b64('🙂'),
            b64('A\nB'),
            '/w==',
        ]) {
            const before = f.saved(1)
            assert.throws(() => f.call(1, 'ChangeFriendRemark', { id: 2, remark: value }), {
                code: ErrorCode.InvalidNick,
            })
            assert.deepEqual(f.saved(1), before)
        }
        assert.throws(() => validateFriendRemark(tables, '***'), { code: ErrorCode.InvalidNick })
    } finally {
        f.close()
    }
})
test('current ownership/self/unknown target boundaries and actual delete/readd or block clear remarks without peer leakage', () => {
    const f = fixture()
    try {
        for (const [id, code] of [
            [1, ErrorCode.CannotOptYourSelf],
            [3, ErrorCode.TargetIsNotYourFriend],
            [99999, ErrorCode.InvalidTarget],
        ]) {
            const before = [f.saved(1), f.saved(2), f.saved(3)]
            assert.throws(() => f.note(1, id, '好友'), { code })
            assert.deepEqual([f.saved(1), f.saved(2), f.saved(3)], before)
        }
        f.note(1, 2, '好友甲')
        f.note(2, 1, '好友乙')
        f.call(1, 'OpFriend', { optype: 1, op: 2, id: 2 })
        assert.deepEqual(f.state(1).friendRemarks, {})
        assert.deepEqual(f.state(2).friendRemarks, {})
        f.call(1, 'OpFriend', { optype: 2, op: 1, id: 2 })
        f.call(2, 'OpFriend', { optype: 1, op: 1, id: 1 })
        assert.equal(row(f, f.login(1), 2).remark, undefined)
        f.note(1, 2, '好友丙')
        f.call(1, 'OpFriend', { optype: 3, op: 1, id: 2 })
        assert.deepEqual(f.state(1).friendRemarks, {})
        assert.deepEqual(f.state(1).friends, [])
    } finally {
        f.close()
    }
})
test('real6232 response codec and SQL abort roll back owner revision and untouched peers; private SQLite reopen preserves current remark', () => {
    const work = path.resolve(cfg.base, '../work/obt-runtime-errors-20261126/friend-remark-current-agent')
    fs.mkdirSync(work, { recursive: true })
    const dir = fs.mkdtempSync(path.join(work, 'private-db-')),
        file = path.join(dir, 'state.sqlite')
    // Generated test database only; no real DB read or removal operation.
    const f = fixture(file)
    try {
        const before = [f.saved(1), f.saved(2)],
            r = f.frame('ChangeFriendRemark', { id: 2, remark: b64('重试好友') }),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byId.get(6232).rsp) throw Error('remark-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.dispatch(1, r), /remark-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual([f.saved(1), f.saved(2)], before)
        f.store.db.exec(
            "CREATE TRIGGER remark_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'remark-sql'); END",
        )
        try {
            assert.throws(() => f.dispatch(1, r), /remark-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER remark_abort')
        }
        assert.deepEqual([f.saved(1), f.saved(2)], before)
        f.dispatch(1, r)
        assert.equal(row(f, f.login(1), 2).remark, b64('重试好友'))
    } finally {
        f.close()
    }
    const reopened = fixture(file)
    try {
        assert.equal(row(reopened, reopened.login(1), 2).remark, b64('重试好友'))
    } finally {
        reopened.close()
    }
})
