import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { validatePlayerNameBytes, validatePlayerSignBytes, planPlayerRename } from '../src/player-text.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
function fixture(name) {
    const store = new Store(':memory:'),
        time = { now: 1800000000 },
        game = new Game(protocol, store, tables, { clock: () => time.now })
    let session = {},
        seq = 1
    const frame = (name, r = {}) => {
            const e = protocol.byName.get('CSProto' + name)
            return { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) }
        },
        dispatch = (f) => game.dispatch(session, f),
        call = (n, r) => dispatch(frame(n, r)),
        state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'player-text-' + name })
    assert.equal(state().mall?.popupQueue?.length ?? 0, 0)
    assert.equal(state().mall?.pendingPopup, undefined)
    const warm = call('GetRechargePopupData').find((p) => p.id === 18048)
    assert.equal(protocol.decode(protocol.byId.get(warm.id).rsp, warm.payload).popup_id ?? 0, 0)
    return {
        store,
        time,
        game,
        frame,
        dispatch,
        call,
        state,
        raw: () => ({
            state: state(),
            sql: store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
        }),
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: 'player-text-' + name, reconnect: true })
        },
    }
}
const decoded = (p) => protocol.decode(protocol.byId.get(p.id).rsp, p.payload)
const beforeAck = (ps, id) => {
    assert(
        ps.findIndex((p) => p.id === 5008) >= 0 &&
            ps.findIndex((p) => p.id === 5008) < ps.findIndex((p) => p.id === id),
    )
}
test('name1 full-width14 differs from signature0 StringLength40; initial digits apply only to current new-player confirmation', () => {
    for (const s of ['Alice', 'A'.repeat(14), '汉'.repeat(7), 'カナ', '안녕', 'ｱ'.repeat(14)])
        assert.equal(validatePlayerNameBytes(tables, b64(s)), b64(s))
    for (const s of ['', 'A'.repeat(15), '汉'.repeat(8), 'A B', 'A_B', 'A\n', '😀', '\ufeffA'])
        assert.throws(
            () => validatePlayerNameBytes(tables, b64(s)),
            (e) => e.code === ErrorCode.InvalidNick,
        )
    assert.equal(
        validatePlayerNameBytes(tables, b64('A1234567')),
        b64('A1234567'),
        'rename source has no initial digit gate',
    )
    assert.throws(
        () => validatePlayerNameBytes(tables, b64('A1234567'), { initial: true }),
        (e) => e.code === ErrorCode.InvalidNick,
    )
    assert.equal(validatePlayerNameBytes(tables, b64('１２３A'), { initial: true }), b64('１２３A'))
    assert.throws(
        () => validatePlayerNameBytes(tables, b64('１２３４A'), { initial: true }),
        (e) => e.code === ErrorCode.InvalidNick,
    )
    for (const s of ['', 'A'.repeat(40), '汉'.repeat(20), 'Ａ'.repeat(40), 'a b!'])
        assert.equal(validatePlayerSignBytes(tables, b64(s)), b64(s))
    for (const s of ['A'.repeat(41), '汉'.repeat(21), '😀', 'a\0', '\ufeffA'])
        assert.throws(
            () => validatePlayerSignBytes(tables, b64(s)),
            (e) => e.code === ErrorCode.InvalidNick,
        )
    assert.equal(validatePlayerSignBytes(tables, undefined), '')
    for (const bad of ['a===', 'YWJj\n', 'AA'])
        assert.throws(
            () => validatePlayerNameBytes(tables, bad),
            (e) => e.code === ErrorCode.InvalidNick,
        )
    assert.throws(
        () => validatePlayerNameBytes(tables, Buffer.from([0xc0, 0x80]).toString('base64')),
        (e) => e.code === ErrorCode.InvalidNick,
    )
})
test('real6135 rename is free, syncs new bytes/time before callback and persists the current seven-day cooldown', () => {
    const f = fixture('rename')
    try {
        const assets = structuredClone({ attrs: f.state().player.attr_infos, bag: f.state().player.sbag_infos }),
            text = '新风长伴',
            ps = f.call('ChangeName', { name: b64(text) })
        beforeAck(ps, 6135)
        const basic = decoded(ps.find((p) => p.id === 5008)).basic_info
        assert.equal(Buffer.from(basic.name, 'base64').toString('utf8'), text)
        assert.equal(basic.last_change_name_time, f.time.now)
        assert.equal(f.state().player.basic_info.name, b64(text))
        assert.equal(f.state().player.basic_info.last_change_name_time, f.time.now)
        assert.deepEqual({ attrs: f.state().player.attr_infos, bag: f.state().player.sbag_infos }, assets)
        const before = f.raw()
        assert.throws(
            () => f.call('ChangeName', { name: b64('另一新名') }),
            (e) => e.code === ErrorCode.ChangeNameTimeLimit,
        )
        assert.deepEqual(f.raw(), before)
        f.time.now += 604799
        assert.throws(
            () => f.call('ChangeName', { name: b64('另一新名') }),
            (e) => e.code === ErrorCode.ChangeNameTimeLimit,
        )
        f.time.now++
        f.call('ChangeName', { name: b64('另一新名') })
        assert.equal(f.state().player.basic_info.last_change_name_time, f.time.now)
        f.reconnect()
        assert.equal(f.state().player.basic_info.name, b64('另一新名'))
        assert.equal(f.state().player.basic_info.last_change_name_time, f.time.now)
    } finally {
        f.store.close()
    }
})
test('actual6136 signature accepts40 ASCII/20Han/40fullwidth Latin and clears; unavailable chars/overlong bytes fail without mutation', () => {
    const f = fixture('signature')
    try {
        for (const text of ['A'.repeat(40), '汉'.repeat(20), 'Ａ'.repeat(40), '']) {
            const ps = f.call('ChangeSign', { sign: b64(text) })
            beforeAck(ps, 6136)
            assert.equal(f.state().player.basic_info.sign ?? '', b64(text))
            assert.equal(decoded(ps.find((p) => p.id === 5008)).basic_info.sign ?? '', b64(text))
        }
        const before = f.raw()
        for (const text of ['A'.repeat(41), '汉'.repeat(21), '😀', 'x\0', '\ufeffA'])
            assert.throws(
                () => f.call('ChangeSign', { sign: b64(text) }),
                (e) => e.code === ErrorCode.InvalidNick,
            )
        assert.deepEqual(f.raw(), before)
        f.reconnect()
        assert.equal(f.state().player.basic_info.sign ?? '', '')
    } finally {
        f.store.close()
    }
})
test('rename unknown flag modes remain unsupported, same-name bypass cannot change cooldown, malformed time stays config failure', () => {
    const f = fixture('mode')
    try {
        const before = f.raw()
        for (const extra of [{ check: 2 }, { cr: 1 }])
            assert.throws(
                () => f.call('ChangeName', { name: b64('新风'), ...extra }),
                (e) => e.code === ErrorCode.FunctionClosed,
            )
        assert.throws(
            () => f.call('ChangeName', { name: f.state().player.basic_info.name }),
            (e) => e.code === ErrorCode.InvalidNick,
        )
        assert.deepEqual(f.raw(), before)
        const s = structuredClone(f.state())
        s.player.basic_info.last_change_name_time = -1
        assert.throws(
            () => planPlayerRename(tables, s, { name: b64('新风') }, f.time.now),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})
test('name and signature ACK codec/SQL failures roll back bytes/time and preserve assets; successful retry survives cold login', () => {
    for (const operation of ['ChangeName', 'ChangeSign'])
        for (const fault of ['codec', 'sql']) {
            const f = fixture(operation + '-' + fault)
            try {
                const field = operation === 'ChangeName' ? 'name' : 'sign',
                    request = f.frame(operation, { [field]: b64('新风安好') }),
                    before = f.raw(),
                    encode = protocol.encode
                if (fault === 'codec')
                    protocol.encode = function (type, value) {
                        if (type === 'cs.ProtoNullRsp') throw Error('text ACK codec failure')
                        return encode.call(this, type, value)
                    }
                else
                    f.store.db.exec(
                        "CREATE TRIGGER fail_text BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'text SQL failure'); END",
                    )
                try {
                    assert.throws(
                        () => f.dispatch(request),
                        new RegExp('text ' + (fault === 'codec' ? 'ACK codec' : 'SQL') + ' failure'),
                    )
                } finally {
                    protocol.encode = encode
                    if (fault === 'sql') f.store.db.exec('DROP TRIGGER fail_text')
                }
                assert.deepEqual(f.raw(), before)
                f.dispatch(request)
                assert.equal(f.state().player.basic_info[field], b64('新风安好'))
                f.reconnect()
                assert.equal(f.state().player.basic_info[field], b64('新风安好'))
            } finally {
                f.store.close()
            }
        }
})
