import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, tables, protocol, letters, read, deliveredGift } from './pami-fixture.js'
import { pamiCoverage } from '../src/pami-mail.js'
import { ErrorCode } from '../src/error-codes.js'
const choose = (f, text) => {
    const row = tables.find('pami_letter_text', text),
        reply = tables.get('pami_letter_reply').find((r) => r.teamId === row.teamId)
    return f.call('PamiMailChoose', { text_id: text, reply_id: reply.id })
}
const claim = (f, text = 3010201) => f.call('PamiMailReward', { u32: text })
const stock = (s, id) => s.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((n, r) => n + r.itemnum, 0)
test('9973 a valid delivered gift enters real inventory once and preserves ordinary mail', () => {
    const f = setup()
    try {
        deliveredGift(f)
        const before = f.state(),
            out = claim(f),
            reward = out.find((p) => p.id === 9973).data
        assert.deepEqual(
            reward.rewards.map((r) => [r.itemtype, r.itemid, r.itemnum]),
            [[3, 300000, 5]],
        )
        assert.equal(stock(f.state(), 300000), stock(before, 300000) + 5)
        assert.deepEqual(f.state().mail, before.mail)
        assert.deepEqual(f.state().pamiMail.letters[30102].reward, [3010201])
        const ack = out.findIndex((p) => p.id === 9973),
            sync = out.findIndex((p) => p.id === 9970)
        assert(ack >= 0 && sync > ack)
        const bagSync = out.findIndex((p) => p.data.sbag_infos?.items?.some((i) => i.itemid === 300000))
        assert(bagSync >= 0 && bagSync < ack)
        const after = f.state()
        assert.deepEqual(claim(f).find((p) => p.id === 9973).data.rewards, [])
        assert.deepEqual(f.state(), after)
        assert.equal(f.state().pamiMail.letters[30102].completed_at, undefined)
    } finally {
        f.close()
    }
})
test('9973 real second-gift conversation and attachment unlock Native120-second third gift, without pretending first-gift success', () => {
    const f = setup()
    try {
        deliveredGift(f)
        choose(f, 3010201)
        assert.equal(f.state().pamiMail.letters[30103], undefined)
        const delivery = claim(f)
        const sent = delivery
            .find((p) => p.id === 9970)
            ?.data.mail_tab.flatMap((t) => t.contents)
            .find((e) => e.mail_id === 30103)
        assert(sent, 'real Game.dispatch must pre-send the future letter before any additional player request')
        assert.equal(sent.timestamp, f.now())
        assert.deepEqual(sent.reply, [{ text_id: 3010301, record: 0, timestamp: f.now() }])
        assert.equal(sent.timestamp + tables.find('pami_letter_list', 30103).time, f.now() + 120)
        const queued = f.state().pamiMail.letters[30103]
        assert(queued)
        assert.equal(queued.timestamp, f.now())
        assert.equal(queued.reply[0].timestamp, f.now())
        assert(letters(f).some((l) => l.mail_id === 30103))
        for (const action of [() => read(f, 30103), () => claim(f, 3010301), () => choose(f, 3010301)]) {
            const before = f.store.load(f.session.id)
            assert.throws(action, (e) => e.code === ErrorCode.PamiLetterNotFound)
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        f.advance(119)
        assert.throws(
            () => read(f, 30103),
            (e) => e.code === ErrorCode.PamiLetterNotFound,
        )
        f.advance(1)
        read(f, 30103)
        const before = stock(f.state(), 306000)
        claim(f, 3010301)
        assert.equal(f.state().pamiMail.letters[30103].completed_at, undefined)
        choose(f, 3010301)
        assert.equal(stock(f.state(), 306000), before + 5)
        for (const id of [30102, 30103]) {
            const e = f.state().pamiMail.letters[id]
            assert(e.completed_at !== undefined)
            assert.deepEqual(e.reward, [id * 100 + 1])
        }
    } finally {
        f.close()
    }
})
test('9973 missing current305021 quarantines the first gift and never manufactures an unknown item or completed flag', () => {
    const f = setup()
    try {
        assert.equal(tables.find('common_item', 305021), undefined)
        assert(pamiCoverage(tables).rejected.some((r) => r.id === 30101 && r.reasons.some((s) => s.includes('305021'))))
        f.store.transact(f.session.id, 0, (s) => (s.taskRecords ??= []).push({ task_id: 206033, count: 1 }))
        f.call('EnterGame', { open_id: 'pami-mail' }, {})
        assert(!letters(f).some((l) => l.mail_id === 30101))
        assert.equal(f.state().pamiMail.letters[30102], undefined)
        const before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f, 3010101),
            (e) => e.code === ErrorCode.PamiLetterNotFound,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('9973 unknown/orphan/locked source, no attachment and letter-ID confusion are atomic failures', () => {
    const f = setup()
    try {
        for (const [id, code] of [
            [999999, ErrorCode.PamiLetterTextConfFail],
            [1010101, ErrorCode.PamiLetterNotFound],
            [3010201, ErrorCode.PamiLetterNotFound],
            [1068101, ErrorCode.InvalidArgument],
            [30102, ErrorCode.PamiLetterTextConfFail],
        ]) {
            const before = f.store.load(f.session.id)
            assert.throws(
                () => claim(f, id),
                (e) => e.code === code,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.close()
    }
})
test('9973 real reward/communication codec failures roll back stock, claimed/completed flags and queued successor', () => {
    const f = setup()
    try {
        deliveredGift(f)
        choose(f, 3010201)
        for (const type of [protocol.byId.get(9970).rsp, protocol.byId.get(9973).rsp]) {
            const before = f.store.load(f.session.id),
                encode = protocol.encode
            protocol.encode = function (t, v) {
                if (t === type) throw Error('Pami reward codec')
                return encode.call(this, t, v)
            }
            try {
                assert.throws(() => claim(f), /Pami reward codec/)
            } finally {
                protocol.encode = encode
            }
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.close()
    }
})
test('9973 malformed later reward cannot partially grant the first item or finish a letter', () => {
    const f = setup(),
        row = tables.get('pami_letter_text').find((r) => r.id === 3010201),
        reward = row.reward
    try {
        deliveredGift(f)
        choose(f, 3010201)
        const before = f.store.load(f.session.id)
        row.reward = '3#300000#5|999#1#1'
        assert.throws(() => claim(f))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        row.reward = reward
        f.close()
    }
})
test('9973 real SQLite restart retains claimed flags/pending timestamp and never re-awards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-pami-reward-')),
        file = path.join(dir, 'db.sqlite')
    let f = setup(file)
    try {
        deliveredGift(f)
        choose(f, 3010201)
        claim(f)
        const e = f.state().pamiMail.letters[30103],
            amount = stock(f.state(), 300000)
        f.close()
        f = setup(file)
        assert.deepEqual(f.state().pamiMail.letters[30103], e)
        assert.equal(stock(f.state(), 300000), amount)
        assert.deepEqual(claim(f).find((p) => p.id === 9973).data.rewards, [])
        assert.throws(
            () => claim(f, 3010301),
            (err) => err.code === ErrorCode.PamiLetterNotFound,
        )
    } finally {
        f.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-pami-reward-'))
        fs.rmSync(dir, { recursive: true })
    }
})
