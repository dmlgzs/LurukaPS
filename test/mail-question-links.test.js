import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { mailQuestionLink } from '../src/mail-question-links.js'
import source from '../configs/mail-question-links.json' with { type: 'json' }

const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
const entry = protocol.byName.get('CSProtoGetQuestionLink'),
    instant = 1800000000
const ids = ['9007199254740993', '9007199254740994', '9007199254740995', '9007199254740996', '18446744073709551615']
function mail(index = 0, fields = {}) {
    return {
        guid: ids[index],
        template_id: 3003 + index,
        createtm: instant - 10,
        effecttm: 100,
        read: false,
        fetch: false,
        collect: false,
        ...fields,
    }
}
function fixture(filename = ':memory:', openId = 'question-links') {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => instant }),
        session = {}
    const login = protocol.byName.get('CSProtoEnterGame')
    game.dispatch(session, { id: login.id, seq: 1, payload: protocol.encode(login.req, { open_id: openId }) })
    return {
        store,
        game,
        session,
        query: (u64 = ids[0]) =>
            game.dispatch(session, {
                id: entry.id,
                seq: 71,
                pushSeq: 13,
                payload: protocol.encode(entry.req, { u64 }),
            }),
    }
}
function inject(f, mails = ids.map((_, i) => mail(i))) {
    f.store.transact(f.session.id, 0, (state) => {
        state.mail = mails
    })
}
function snapshot(f) {
    return {
        player: f.store.db.prepare('SELECT * FROM players WHERE account_id=?').get(f.session.id),
        logs: f.store.db.prepare('SELECT count(*) AS n FROM request_log').get(),
        pending: structuredClone([...f.store.pending]),
    }
}
function error(code) {
    return (e) => {
        assert.equal(e.code, code)
        return true
    }
}
function check(row, override = {}, cfg = source) {
    return mailQuestionLink({ state: { mail: [row] }, now: instant, ...override }, { u64: row.guid }, cfg)
}

test('10770 opens all five actual template links using complete uint64 GUIDs without writes or unrelated refresh', () => {
    const f = fixture()
    try {
        inject(f)
        // If this query accidentally re-enters the ordinary transaction path it must fail.
        f.store.transact = () => {
            throw Error('query must not transact')
        }
        const before = snapshot(f)
        for (let i = 0; i < ids.length; i++) {
            const packets = f.query(ids[i])
            assert.equal(packets.length, 1)
            assert.equal(packets[0].id, entry.id)
            assert.equal(packets[0].seq, 71)
            assert.equal(
                protocol.decode(entry.rsp, packets[0].payload).link,
                source.templates.find((row) => row.id === 3003 + i).link,
            )
        }
        assert.deepEqual(snapshot(f), before)
        assert.equal(source.templates.length, 34)
        assert.equal(source.templates.filter((row) => row.jump_type === 3).length, 5)
        assert.equal(source.source.sha256, 'ef44058ac5e86af302170c02e0192d57c3b1d4455400e1af06094c0e56b5caf3')
    } finally {
        f.store.close()
    }
})

test('GUID authorization rejects missing, zero, wrong owner, unsafe number and duplicate identity', () => {
    const f = fixture(),
        peer = {},
        login = protocol.byName.get('CSProtoEnterGame')
    try {
        f.game.dispatch(peer, {
            id: login.id,
            seq: 1,
            payload: protocol.encode(login.req, { open_id: 'different-owner' }),
        })
        inject(f, [mail()])
        f.store.transact(peer.id, 0, (state) => {
            state.mail = [mail(1)]
        })
        const before = snapshot(f)
        assert.throws(() => f.query(ids[1]), error(ErrorCode.NoMail))
        assert.throws(() => f.query('0'), error(ErrorCode.InvalidMailID))
        assert.throws(
            () => mailQuestionLink({ state: { mail: [mail()] }, now: instant }, { u64: Number(ids[0]) }),
            error(ErrorCode.InvalidMailID),
        )
        for (const value of ['-1', '01', '18446744073709551616', '1e10', ''])
            assert.throws(
                () => mailQuestionLink({ state: { mail: [mail()] }, now: instant }, { u64: value }),
                error(ErrorCode.InvalidMailID),
            )
        assert.throws(
            () => mailQuestionLink({ state: { mail: [mail(), mail()] }, now: instant }, { u64: ids[0] }),
            error(ErrorCode.MailConfigError),
        )
        assert.throws(() => check(mail(0, { is_delete: true })), error(ErrorCode.NoMail))
        assert.deepEqual(snapshot(f), before)
    } finally {
        f.store.close()
    }
})

test('validity uses duration plus creation and dispatch server seconds; collect and zero duration do not expire', () => {
    const defaults = { guid: ids[0], template_id: 3003 }
    assert(check(defaults).link, 'absent effecttm, collect and is_delete keep protobuf default semantics')
    assert.equal(check(mail(0, { effecttm: 11 })).link, source.templates.find((row) => row.id === 3003).link)
    for (const duration of [10, 9])
        assert.throws(() => check(mail(0, { effecttm: duration })), error(ErrorCode.MailOverTime))
    assert(check(mail(0, { createtm: 1, effecttm: 1, collect: true })).link)
    assert(check(mail(0, { createtm: 1, effecttm: 0 })).link)
    for (const fields of [
        { createtm: -1 },
        { effecttm: -1 },
        { effecttm: 1.5 },
        { collect: 1 },
        { createtm: 0xffffffff, effecttm: 1 },
    ])
        assert.throws(() => check(mail(0, fields)), error(ErrorCode.MailConfigError))
    const f = fixture()
    try {
        inject(f, [mail(0, { createtm: instant - 100, effecttm: 100 })])
        const before = snapshot(f)
        assert.throws(() => f.query(), error(ErrorCode.MailOverTime))
        assert.deepEqual(snapshot(f), before)
    } finally {
        f.store.close()
    }
})

test('template and URL failures distinguish unavailable links from damaged static configuration', () => {
    assert.throws(() => check(mail(0, { template_id: 1 })), error(ErrorCode.MailUrlNotFound))
    for (const template_id of [0, 999999, -1, '3003'])
        assert.throws(() => check(mail(0, { template_id })), error(ErrorCode.MailConfigError))
    const mutate = (fn) => {
        const cfg = structuredClone(source)
        fn(cfg)
        return cfg
    }
    assert.throws(
        () =>
            check(
                mail(),
                {},
                mutate((cfg) => {
                    cfg.templates = [null]
                }),
            ),
        error(ErrorCode.MailConfigError),
    )
    assert.throws(
        () =>
            check(
                mail(),
                {},
                mutate((cfg) => cfg.templates.push({ ...cfg.templates.find((row) => row.id === 3003) })),
            ),
        error(ErrorCode.MailConfigError),
    )
    assert.throws(
        () =>
            check(
                mail(),
                {},
                mutate((cfg) => {
                    cfg.templates.find((row) => row.id === 3003).jump_type = '3'
                }),
            ),
        error(ErrorCode.MailConfigError),
    )
    assert.throws(
        () =>
            check(
                mail(),
                {},
                mutate((cfg) => {
                    cfg.templates.find((row) => row.id === 3003).link = ''
                }),
            ),
        error(ErrorCode.MailUrlNotFound),
    )
    for (const link of [
        'http://survey.manjuu.com/vm/a.aspx',
        'javascript:alert(1)',
        'https://evil.example/a',
        'https://survey.manjuu.com.evil.example/a',
        'https://user@survey.manjuu.com/a',
        'https://survey.manjuu.com:444/a',
        'https://survey.manjuu.com/a#x',
        'https://SURVEY.manjuu.com/a',
        'invalid',
    ])
        assert.throws(
            () =>
                check(
                    mail(),
                    {},
                    mutate((cfg) => {
                        cfg.templates.find((row) => row.id === 3003).link = link
                    }),
                ),
            error(ErrorCode.MailConfigError),
        )
    const row = mail(0, { args: [{ key: 'url', value: 'https://evil.example/' }] })
    assert.equal(check(row).link, source.templates.find((row) => row.id === 3003).link)
})

test('response codec failure preserves live pending state, saved state, request log and mail flags', () => {
    const f = fixture()
    try {
        inject(f)
        f.store.transact(
            f.session.id,
            0,
            (state) => {
                state.mail[0].title = 'pending'
            },
            { defer: true },
        )
        const before = snapshot(f),
            encode = protocol.encode
        protocol.encode = function (type, data) {
            if (type === entry.rsp) throw Error('question-codec-failure')
            return encode.call(this, type, data)
        }
        try {
            assert.throws(() => f.query(), /question-codec-failure/)
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(snapshot(f), before)
        assert.equal(
            protocol.decode(entry.rsp, f.query()[0].payload).link,
            source.templates.find((row) => row.id === 3003).link,
        )
        assert.deepEqual(snapshot(f), before)
    } finally {
        f.store.close()
    }
})

test('SQLite reopen preserves owned mail and collected links without writing during queries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-question-link-')),
        filename = path.join(dir, 'test.sqlite')
    let f
    try {
        f = fixture(filename)
        inject(f, [mail(4, { createtm: 1, effecttm: 1, collect: true })])
        f.store.close()
        f = fixture(filename)
        const before = snapshot(f)
        assert.equal(
            protocol.decode(entry.rsp, f.query(ids[4])[0].payload).link,
            source.templates.find((row) => row.id === 3007).link,
        )
        assert.deepEqual(snapshot(f), before)
        f.session.entered = false
        assert.throws(() => f.query(ids[4]), error(ErrorCode.HaveNotEnterGame))
        assert.deepEqual(snapshot(f), before)
    } finally {
        f?.store.close()
        const absolute = path.resolve(dir),
            parent = path.resolve(os.tmpdir())
        assert.equal(path.dirname(absolute), parent)
        assert(path.basename(absolute).startsWith('lurukaps-question-link-'))
        fs.rmSync(absolute, { recursive: true, force: true })
    }
})
