import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
import { mailEffectValid, selectMailRewards } from '../src/mail-lifetime.js'
const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)
const now = 1800000000,
    id = '9007199254740993'
function mail(fields = {}) {
    return {
        guid: id,
        createtm: now - 10,
        effecttm: 30,
        fetch: false,
        read: false,
        collect: false,
        reward: {
            rewards: [
                { itemtype: 10, itemid: 2, itemnum: 7 },
                { itemtype: 3, itemid: 400000, itemnum: 3 },
            ],
        },
        ...fields,
    }
}
function fixture(filename = ':memory:', openId = 'mail-lifetime') {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    call('EnterGame', { open_id: openId })
    return {
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        inject: (mails) =>
            store.transact(session.id, 0, (state) => {
                state.mail = mails
            }),
        reply: (packets) => protocol.decode('cs.SCMailFetch', packets.find((p) => p.id === 6121).payload),
    }
}
const error = (code) => (e) => {
    assert.equal(e.code, code)
    return true
}
const bag = (state) =>
    state.player.sbag_infos.items.filter((r) => r.itemid === 400000).reduce((n, r) => n + r.itemnum, 0)
function snapshot(f) {
    return {
        rows: f.store.db.prepare('SELECT * FROM players').all(),
        logs: f.store.db.prepare('SELECT * FROM request_log').all(),
        pending: structuredClone([...f.store.pending]),
    }
}
test('CBT3 lifetime is strict creation plus duration; permanent and collected remain valid', () => {
    assert.equal(mailEffectValid(mail({ createtm: now - 30 }), now), false)
    assert.equal(mailEffectValid(mail({ createtm: now - 29 }), now), true)
    assert.equal(mailEffectValid(mail({ createtm: 1, effecttm: 0 }), now), true)
    assert.equal(mailEffectValid(mail({ createtm: 1, effecttm: 1, collect: true }), now), true)
    for (const fields of [
        { effecttm: -1 },
        { effecttm: 1.5 },
        { collect: 'yes' },
        { createtm: -1 },
        { createtm: 0xffffffff, effecttm: 1 },
    ])
        assert.throws(() => mailEffectValid(mail(fields), now), error(ErrorCode.MailConfigError))
})
test('selection preserves complete uint64 identity, ownership, duplicate detection and expired-specific errors', () => {
    const check = (rows, u64) => selectMailRewards({ mail: rows }, { u64 }, now)
    assert.equal(check([mail()], id).length, 1)
    assert.throws(() => check([mail()], '9007199254740994'), error(ErrorCode.NoMail))
    assert.throws(() => check([mail({ is_delete: true })], id), error(ErrorCode.NoMail))
    assert.throws(() => check([mail({ createtm: 1 })], id), error(ErrorCode.MailOverTime))
    assert.throws(() => check([mail(), mail()], '0'), error(ErrorCode.MailConfigError))
    assert.throws(() => check([mail()], Number(id)), error(ErrorCode.InvalidMailID))
    assert.throws(() => check([mail({ fetch: true })], id), error(ErrorCode.AlreadyGetReward))
})
test('real6121 grants typed attachments once from finite valid mail and uses6124 flags', () => {
    const f = fixture()
    try {
        f.inject([mail()])
        const before = f.state(),
            packets = f.call('FetchMail', { u64: id })
        assert.deepEqual(f.reply(packets).guids, [id])
        assert.equal(f.reply(packets).errcode, ErrorCode.Succ)
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold + 7)
        assert.equal(bag(f.state()), bag(before) + 3)
        const push = packets.find((p) => p.id === 6124),
            payload = protocol.decode('cs.SCMailSync', push.payload)
        assert.equal(payload.mails[0].fetch, true)
        assert.equal(payload.mails[0].read, true)
        const granted = f.state()
        assert.throws(() => f.call('FetchMail', { u64: id }), error(ErrorCode.AlreadyGetReward))
        assert.deepEqual(f.state().player, granted.player)
    } finally {
        f.store.close()
    }
})
test('all0 skips expired and deleted mail but includes permanent and collected finite mail', () => {
    const f = fixture()
    try {
        f.inject([
            mail({ guid: '1', createtm: 1 }),
            mail({ guid: '2', is_delete: true }),
            mail({ guid: '3', effecttm: 0 }),
            mail({ guid: '4', createtm: 1, effecttm: 1, collect: true }),
        ])
        const before = f.state()
        assert.deepEqual(f.reply(f.call('FetchMail', { u64: '0' })).guids, ['3', '4'])
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold + 14)
        assert.equal(f.state().mail[0].fetch, false)
        assert.equal(f.state().mail[1].fetch, false)
    } finally {
        f.store.close()
    }
})
test('expired and malformed target failures preserve pending, saved state and request log', () => {
    const f = fixture()
    try {
        f.inject([mail({ createtm: 1 })])
        const before = snapshot(f)
        assert.throws(() => f.call('FetchMail', { u64: id }), error(ErrorCode.MailOverTime))
        assert.deepEqual(snapshot(f), before)
        f.inject([mail({ effecttm: -1 })])
        const bad = snapshot(f)
        assert.throws(() => f.call('FetchMail', { u64: id }), error(ErrorCode.MailConfigError))
        assert.deepEqual(snapshot(f), bad)
    } finally {
        f.store.close()
    }
})
test('response and mail-sync codec failure roll back attachment grant and read/fetch flags', () => {
    const f = fixture(),
        encode = protocol.encode
    try {
        f.inject([mail()])
        for (const failed of ['cs.SCMailFetch', 'cs.SCMailSync']) {
            const before = snapshot(f)
            protocol.encode = function (type, value) {
                if (type === failed) throw Error('mail-codec-test')
                return encode.call(this, type, value)
            }
            try {
                assert.throws(() => f.call('FetchMail', { u64: id }), /mail-codec-test/)
            } finally {
                protocol.encode = encode
            }
            assert.deepEqual(snapshot(f), before)
        }
        assert.deepEqual(f.reply(f.call('FetchMail', { u64: id })).guids, [id])
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})
test('actual temporary SQLite close/reopen retains duration and duplicate-claim receipt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-mail-life-')),
        filename = path.join(dir, 'mail.sqlite')
    let f = fixture(filename)
    try {
        f.inject([mail()])
        f.store.close()
        f = fixture(filename)
        assert.deepEqual(f.reply(f.call('FetchMail', { u64: id })).guids, [id])
        const gold = f.state().player.basic_info.gold
        f.store.close()
        f = fixture(filename)
        assert.equal(f.state().mail[0].fetch, true)
        assert.throws(() => f.call('FetchMail', { u64: id }), error(ErrorCode.AlreadyGetReward))
        assert.equal(f.state().player.basic_info.gold, gold)
    } finally {
        f.store.close()
        assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
