import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, tables, protocol, letters, read, deliveredGift } from './pami-fixture.js'
import { preparePamiMail } from '../src/pami-mail.js'
import { ErrorCode } from '../src/error-codes.js'
const choices = (text) =>
    tables.get('pami_letter_reply').filter((r) => r.teamId === tables.find('pami_letter_text', text).teamId)
const choose = (f, text = 1068101, reply = choices(text)[0].id) =>
    f.call('PamiMailChoose', { text_id: text, reply_id: reply })
test('9972 commits a configured option on the source text and synchronizes authority after ACK', () => {
    const f = setup()
    try {
        read(f)
        const before = f.state(),
            out = choose(f),
            ack = out.findIndex((p) => p.id === 9972),
            sync = out.findIndex((p) => p.id === 9970)
        assert(ack >= 0 && sync >= 0 && ack < sync)
        const entry = letters(f).find((l) => l.mail_id === 10681)
        assert.equal(entry.reply.length, 1)
        assert.equal(entry.reply[0].text_id, 1068101)
        assert.equal(entry.reply[0].record, choices(1068101)[0].id)
        assert(entry.latest_read)
        assert.deepEqual(f.state().player, before.player)
        assert.deepEqual(f.state().mail, before.mail)
        const after = f.state()
        f.advance(50)
        choose(f)
        assert.deepEqual(f.state(), after)
    } finally {
        f.close()
    }
})
test('9972 invalid, foreign-team, locked-source and conflicting committed options are rejected atomically', () => {
    const f = setup()
    try {
        read(f)
        choose(f)
        for (const [text, reply, code] of [
            [1068101, choices(1068101)[1].id, ErrorCode.InvalidArgument],
            [1068101, choices(1018101)[0].id, ErrorCode.PamiLetterReplyConfFail],
            [1068201, choices(1068201)[0].id, ErrorCode.PamiLetterNotFound],
            [999999, 1, ErrorCode.PamiLetterTextConfFail],
        ]) {
            const before = f.store.load(f.session.id)
            assert.throws(
                () => choose(f, text, reply),
                (e) => e.code === code,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.close()
    }
})
test('9972 conservative12082 requires reading and terminal reply; favor3 then admits the next configured letter', () => {
    const f = setup()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.heros.find((h) => h.conf_id === 101010).favorability_lv = 3
        })
        choose(f)
        assert(!letters(f).some((l) => l.mail_id === 10682))
        assert.equal(f.state().pamiMail.letters[10681].completed_at, undefined)
        read(f)
        assert(letters(f).some((l) => l.mail_id === 10682))
        assert.equal(f.state().pamiMail.letters[10681].completed_at, f.now())
        assert.equal(letters(f).find((l) => l.mail_id === 10682).latest_read, false)
    } finally {
        f.close()
    }
})
test('9972 closed compatibility policy cannot auto-complete12082 or admit its successors', () => {
    const f = setup()
    try {
        const s = f.state(),
            e = s.pamiMail.letters[10681]
        s.player.heros_info.heros.find((h) => h.conf_id === 101010).favorability_lv = 3
        e.latest_read = true
        e.read_at = f.now()
        e.reply[0].record = choices(1068101)[0].id
        s.pamiMail.revision++
        preparePamiMail(tables, s, f.now(), { completionPolicy: 'closed' })
        assert.equal(e.completed_at, undefined)
        assert.equal(s.pamiMail.letters[10682], undefined)
        preparePamiMail(tables, s, f.now(), { completionPolicy: 'conversation-and-rewards' })
        assert(s.pamiMail.letters[10682])
        assert.equal(e.completed_at, f.now())
    } finally {
        f.close()
    }
})
test('9972 a completed conversation with an unclaimed valid attachment cannot unlock its successor', () => {
    const f = setup()
    try {
        deliveredGift(f)
        choose(f, 3010201)
        assert.equal(f.state().pamiMail.letters[30102].completed_at, undefined)
        assert.equal(f.state().pamiMail.letters[30103], undefined)
        assert.deepEqual(f.state().pamiMail.letters[30102].reward, [])
    } finally {
        f.close()
    }
})

test('9972 actual sync and reply encoding failures cannot commit an option or unlock a successor', () => {
    const f = setup()
    try {
        read(f)
        for (const type of [protocol.byId.get(9970).rsp, protocol.byId.get(9972).rsp]) {
            const before = f.store.load(f.session.id),
                encode = protocol.encode
            protocol.encode = function (t, v) {
                if (t === type) throw Error('Pami choose codec')
                return encode.call(this, t, v)
            }
            try {
                assert.throws(() => choose(f), /Pami choose codec/)
            } finally {
                protocol.encode = encode
            }
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.close()
    }
})
test('9972 committed choice and completion survive real SQLite restart without timestamp reroll', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-pami-choose-')),
        file = path.join(dir, 'db.sqlite')
    let f = setup(file)
    try {
        read(f)
        choose(f)
        const entry = f.state().pamiMail.letters[10681]
        f.close()
        f = setup(file)
        assert.deepEqual(f.state().pamiMail.letters[10681], entry)
        choose(f)
        assert.equal(f.state().pamiMail.letters[10681].reply[0].timestamp, entry.reply[0].timestamp)
    } finally {
        f.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-pami-choose-'))
        fs.rmSync(dir, { recursive: true })
    }
})
