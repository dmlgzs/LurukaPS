import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, tables, protocol, letters, read } from './pami-fixture.js'
import { pamiCoverage, preparePamiMail } from '../src/pami-mail.js'
import { ErrorCode } from '../src/error-codes.js'
test('9971 login initializes table/category-qualified unread letters with a native-readable first text envelope', () => {
    const f = setup()
    try {
        const sync = f.login.find((p) => p.id === 9970)
        assert(sync)
        assert.deepEqual(
            sync.data.mail_tab.map((t) => t.mail_type),
            [1, 2, 3],
        )
        const entry = letters(f).find((l) => l.mail_id === 10681)
        assert(entry)
        assert.equal(entry.latest_read, false)
        assert.equal(entry.hero_id, f.state().player.heros_info.heros.find((h) => h.conf_id === 101010).guid)
        assert.deepEqual(entry.reply, [{ text_id: 1068101, record: 0, timestamp: f.now() }])
        assert(!letters(f).some((l) => l.mail_id === 10682))
        assert(!letters(f).some((l) => l.mail_id >= 20101 && l.mail_id <= 20115))
        assert(!letters(f).some((l) => l.mail_id === 30101))
        assert.deepEqual(f.state().mail, [])
    } finally {
        f.close()
    }
})
test('9971 read uses letter ID, pushes9970 before acknowledgement, and is idempotent without claiming gifts', () => {
    const f = setup()
    try {
        const before = f.state(),
            out = read(f)
        let si = out.findIndex((p) => p.id === 9970),
            ack = out.findIndex((p) => p.id === 9971)
        assert(si >= 0 && ack >= 0 && si < ack)
        assert.equal(letters(f).find((l) => l.mail_id === 10681).latest_read, true)
        assert.deepEqual(f.state().player, before.player)
        assert.deepEqual(f.state().mail, before.mail)
        const after = f.state()
        read(f)
        assert.deepEqual(f.state(), after)
        assert.throws(
            () => read(f, 1068101),
            (e) => e.code === ErrorCode.PamiLetterNotFound,
        )
    } finally {
        f.close()
    }
})
test('9971 system/task gate and permanent hero favorability prevent unearned delivery', () => {
    const f = setup(':memory:', false)
    try {
        assert.equal(letters(f).length, 0)
        let before = f.store.load(f.session.id)
        assert.throws(
            () => read(f),
            (e) => e.code === ErrorCode.PamiLetterNotFound,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks.push({ task_id: 106010, finish_nodes: [153], nodes: [] })
            s.player.heros_info.heros.find((h) => h.conf_id === 101010).trail = true
        })
        f.call('EnterGame', { open_id: 'pami-mail' }, {})
        assert(!letters(f).some((l) => l.mail_id === 10681))
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.heros.find((h) => h.conf_id === 101010).trail = false
        })
        read(f)
        assert(letters(f).some((l) => l.mail_id === 10681))
    } finally {
        f.close()
    }
})
test('9971 quarantines broken table references and event templates instead of auto-granting all configured letters', () => {
    const f = setup()
    try {
        const coverage = pamiCoverage(tables)
        assert.equal(coverage.configured, 124)
        assert.equal(coverage.eventLetters.length, 15)
        assert(coverage.rejected.some((r) => r.id === 12385 && r.reasons.some((r) => r.includes('first text'))))
        const before = f.store.load(f.session.id)
        assert.throws(
            () => read(f, 12385),
            (e) => e.code === ErrorCode.PamiLetterNotFound,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        const s = f.state()
        assert.equal(preparePamiMail(tables, s, f.now()), false)
    } finally {
        f.close()
    }
})
test('9971 actual9970 and read reply encoding failures roll back the read flag', () => {
    const f = setup()
    try {
        for (const type of [protocol.byId.get(9970).rsp, protocol.byId.get(9971).rsp]) {
            const before = f.store.load(f.session.id),
                encode = protocol.encode
            protocol.encode = function (t, v) {
                if (t === type) throw Error('Pami read codec')
                return encode.call(this, t, v)
            }
            try {
                assert.throws(() => read(f), /Pami read codec/)
            } finally {
                protocol.encode = encode
            }
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.close()
    }
})
test('9971 read state and source envelope survive a genuine SQLite close/reopen and login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-pami-read-')),
        file = path.join(dir, 'db.sqlite')
    let f = setup(file)
    try {
        read(f)
        const first = letters(f).find((l) => l.mail_id === 10681)
        f.close()
        f = setup(file)
        assert.deepEqual(
            letters(f).find((l) => l.mail_id === 10681),
            first,
        )
        assert.equal(
            f.login.find((p) => p.id === 9970).data.mail_tab[0].contents.find((l) => l.mail_id === 10681).latest_read,
            true,
        )
    } finally {
        f.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-pami-read-'))
        fs.rmSync(dir, { recursive: true })
    }
})
