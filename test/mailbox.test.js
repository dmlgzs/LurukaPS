import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'
import { registerMailbox, observeMailbox, mailboxLegacyPush, MailOperationCode as Code } from '../src/mailbox.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    now = 1800000000
const b64 = (text) => Buffer.from(text).toString('base64')
const guid = '9007199254740993'
const mail = (fields = {}) => ({
    guid,
    createtm: now - 10,
    effecttm: 100,
    template_id: 0,
    sender_id: b64('sender'),
    title: b64('title'),
    content: b64('content'),
    read: false,
    fetch: false,
    collect: false,
    reward: { rewards: [{ itemtype: 10, itemid: 2, itemnum: 7 }] },
    ...fields,
})
function state() {
    return {
        player: {
            basic_info: { id: 1, gold: 0, diamond: 0, lv: 1 },
            attr_infos: { attrs: [] },
            sbag_infos: { items: [] },
        },
        mail: [],
    }
}
function fixture(rows = [], filename = ':memory:', openId = 'mailbox') {
    const store = new Store(filename),
        account = store.login(openId, () => ({ ...state(), mail: rows })),
        handlers = new Map()
    registerMailbox((name, handler) => handlers.set(name, handler))
    let clock = now,
        session = 'connection-1'
    return {
        store,
        handlers,
        setNow: (value) => (clock = value),
        setSession: (value) => (session = value),
        state: () => store.load(account.id).state,
        mutate: (fn) => store.transact(account.id, 0, fn),
        call(name, data = {}, failType) {
            const entry = protocol.byName.get('CSProto' + name),
                request = protocol.decode(entry.req, protocol.encode(entry.req, data))
            return store.transact(account.id, entry.id, (draft) => {
                const before = [],
                    after = []
                const encode = (name, value) => {
                    const e = protocol.byName.get(name)
                    if (e.rsp === failType) throw Error('mailbox-codec-failure')
                    return { name, payload: protocol.encode(e.rsp, value) }
                }
                const response = handlers.get(name)(
                    {
                        state: draft,
                        tables,
                        now: clock,
                        combatSessionId: session,
                        pushBefore: (name, value) => before.push(encode(name, value)),
                        push: (name, value) => after.push(encode(name, value)),
                    },
                    request,
                )
                if (entry.rsp === failType) throw Error('mailbox-codec-failure')
                const payload = protocol.encode(entry.rsp, response)
                return {
                    response: protocol.decode(entry.rsp, payload),
                    packets: [...before, { name: entry.name, payload }, ...after],
                }
            })
        },
        close: () => store.close(),
    }
}
const claim = (id = guid, claimId = 'claim-1', requestId = 'request-1') => ({
    selector: 1,
    mails: [
        { mail_id: id, claim_id: createHash('sha256').update(claimId).digest().subarray(0, 16).toString('base64') },
    ],
    request_id: b64(requestId),
})

test('5900 summary and 5901 pages preserve old mail, uint64 IDs, duration, template bytes and saved claim flags', () => {
    const rows = [
            mail(),
            mail({ guid: '2', read: true, fetch: true }),
            mail({ guid: '3', createtm: 1 }),
            mail({ guid: '4', createtm: 1, collect: true }),
            mail({ guid: '5', visible_time: now + 1 }),
        ],
        f = fixture(rows)
    try {
        const summary = f.call('GetMailboxSummary').response.summary
        assert.equal(summary.total_visible_count, 3)
        assert.equal(summary.favorite_count, 1)
        assert.equal(summary.unclaimed_reward_mail_count, 2)
        const first = f.call('ListMails', { list_type: 1, limit: 1 }).response
        assert.equal(first.mails[0].mail_id, '4')
        assert.equal(first.has_more, true)
        const second = f.call('ListMails', {
            list_type: 1,
            limit: 1,
            cursor: first.cursor,
            known_mailbox_version: first.mailbox_version,
        }).response
        assert.equal(second.mails[0].mail_id, guid)
        assert.equal(second.mails[0].expire_time, now + 90)
        assert.equal(second.mails[0].content, b64('content'))
        assert.deepEqual(f.state().mail, rows)
        const favorites = f.call('ListMails', { list_type: 3 }).response.mails
        assert.deepEqual(
            favorites.map((m) => m.mail_id),
            ['4'],
        )
    } finally {
        f.close()
    }
})

test('5902/5907 journal versions advance one step and legacy delivery/expiry are replayable without deleting stored mail', () => {
    const f = fixture([mail()])
    try {
        f.call('GetMailboxSummary')
        const initial = f.call('SyncMailbox', { since_version: '0', max_deltas: 1 }).response
        assert.equal(initial.deltas[0].base_version, '0')
        assert.equal(initial.deltas[0].mailbox_version, '1')
        f.mutate((draft) => {
            draft.mail.push(mail({ guid: '2' }))
            const pushed = mailboxLegacyPush(tables, draft, now)
            assert.equal(pushed.delta.base_version, '1')
            assert.equal(pushed.delta.mailbox_version, '2')
            assert.equal(pushed.delta.changes[0].mail.mail_id, '2')
            protocol.encode('cs.SCMailboxDelta', pushed)
        })
        const next = f.call('SyncMailbox', { since_version: '1' }).response
        assert.equal(next.deltas.length, 1)
        assert.equal(next.deltas[0].base_version, '1')
        f.setNow(now + 100)
        const expired = f.call('SyncMailbox', { since_version: '2' }).response
        assert.equal(expired.deltas[0].changes.length, 2)
        assert.ok(expired.deltas[0].changes.every((c) => c.type === 2))
        assert.equal(f.state().mail.length, 2)
    } finally {
        f.close()
    }
})

test('pagination rejects stale/wrong cursors, malformed IDs and unknown enums instead of serving a mixed snapshot', () => {
    const f = fixture([mail(), mail({ guid: '2' })])
    try {
        const page = f.call('ListMails', { list_type: 1, limit: 1 }).response
        f.call('MailRead', { mail_id: guid })
        assert.equal(f.call('ListMails', { list_type: 1, cursor: page.cursor }).response.code, Code.Conflict)
        assert.equal(f.call('ListMails', { list_type: 1, cursor: b64('not-json') }).response.code, Code.InvalidCursor)
        assert.equal(f.call('ListMails', { list_type: 0 }).response.code, Code.UnknownEnum)
        assert.equal(f.call('ListMails', { list_type: 1, limit: 1001 }).response.code, Code.InvalidArgument)
        assert.equal(f.call('SyncMailbox', { since_version: '999' }).response.code, Code.Conflict)
        assert.throws(
            () => f.call('MailRead', { mail_id: '0' }),
            (e) => e.code === ErrorCode.InvalidMailID,
        )
    } finally {
        f.close()
    }
})

test('5903/5904 are explicit idempotent setters; replayed reads carry a usable delta and favorite limits come from actual table', () => {
    const f = fixture([mail()])
    try {
        const first = f.call('MailRead', { mail_id: guid }).response,
            second = f.call('MailRead', { mail_id: guid }).response
        assert.equal(first.delta.mailbox_version, second.delta.mailbox_version)
        f.call('MailFavorite', { mail_id: guid, favorite: true })
        f.call('MailFavorite', { mail_id: guid, favorite: true })
        assert.equal(f.state().mail[0].collect, true)
        f.call('MailFavorite', { mail_id: guid, favorite: false })
        assert.equal(f.state().mail[0].collect, false)
        f.mutate((s) => {
            s.mail = Array.from({ length: 301 }, (_, i) => mail({ guid: String(i + 1), collect: i < 300 }))
        })
        assert.equal(f.call('MailFavorite', { mail_id: '301', favorite: true }).response.code, Code.FavoriteLimit)
    } finally {
        f.close()
    }
})

test('5905 protects unread, favorited and unclaimed attachments and preserves idempotent delete receipts', () => {
    const f = fixture([
        mail(),
        mail({ guid: '2', read: true, collect: true, fetch: true }),
        mail({ guid: '3', read: true, fetch: true }),
        mail({ guid: '4', read: true, reward: { rewards: [] } }),
    ])
    try {
        const request = { selector: 2, request_id: b64('delete-all') },
            result = f.call('MailDelete', request).response
        assert.deepEqual(
            result.results.filter((r) => r.code === Code.Ok).map((r) => r.mail_id),
            ['3', '4'],
        )
        assert.equal(f.state().mail.length, 4)
        assert.equal(f.state().mail.find((m) => m.guid === '3').is_delete, true)
        assert.deepEqual(f.call('MailDelete', request).response, result)
        const conflict = f.call('MailDelete', {
            selector: 1,
            mail_ids: [guid],
            request_id: request.request_id,
        }).response
        assert.equal(conflict.code, Code.Conflict)
        assert.equal(
            f.call('MailDelete', { selector: 1, mail_ids: [guid], request_id: b64('protected') }).response.results[0]
                .code,
            Code.Protected,
        )
    } finally {
        f.close()
    }
})

test('5906 request/claim receipts are durable, replay rewards without granting twice and preserve old fetched mail', () => {
    const f = fixture([mail(), mail({ guid: '2', fetch: true })])
    try {
        const request = claim(),
            first = f.call('MailClaim', request).response
        assert.equal(first.results[0].status, 3)
        assert.equal(first.results[0].rewards.rewards[0].itemnum, 7)
        assert.equal(f.state().player.basic_info.gold, 7)
        assert.deepEqual(f.call('MailClaim', request).response, first)
        assert.equal(f.state().player.basic_info.gold, 7)
        assert.equal(f.call('MailClaim', claim(guid, 'claim-1', 'new-request')).response.results[0].status, 3)
        assert.equal(f.state().player.basic_info.gold, 7)
        assert.equal(f.call('MailClaim', claim('2', 'new-claim', 'request-1')).response.code, Code.Conflict)
        assert.equal(
            f.call('MailClaim', claim('2', 'old-fetched', 'request-2')).response.results[0].code,
            Code.NoClaimableReward,
        )
        assert.equal(f.state().player.basic_info.gold, 7)
    } finally {
        f.close()
    }
})

test('5908 acknowledges running before final5909, replays once per connection and handles reset request sequence in a new connection', () => {
    const f = fixture([mail(), mail({ guid: '2' })])
    try {
        const first = f.call('StartMailClaimAll', { request_seq: '1' }),
            ack = first.response
        const push = first.packets.find((p) => p.name === 'SCProtoMailClaimAllUpdate'),
            update = protocol.decode('cs.SCMailClaimAllUpdate', push.payload)
        assert.equal(ack.state, 1)
        assert.equal(update.state, 2)
        assert.equal(update.operation_id, ack.operation_id)
        assert.equal(update.update_seq, '1')
        assert.equal(update.results.length, 2)
        assert.ok(update.results.every((result) => Buffer.from(result.claim_id, 'base64').length === 16))
        assert.equal(f.state().player.basic_info.gold, 14)
        assert.ok(first.packets.findIndex((p) => p.name === 'CSProtoStartMailClaimAll') < first.packets.indexOf(push))
        assert.equal(f.call('StartMailClaimAll', { request_seq: '1' }).response.operation_id, ack.operation_id)
        assert.equal(f.state().player.basic_info.gold, 14)
        f.mutate((s) => s.mail.push(mail({ guid: '3' })))
        f.setSession('connection-2')
        assert.notEqual(f.call('StartMailClaimAll', { request_seq: '1' }).response.operation_id, ack.operation_id)
        assert.equal(f.state().player.basic_info.gold, 21)
    } finally {
        f.close()
    }
})

test('reward and both response/push encoding failures roll back currency, flags, version, receipts and request log atomically', () => {
    const f = fixture([mail()])
    try {
        f.call('GetMailboxSummary')
        for (const failed of ['cs.SCMailClaim', 'cs.SCMailboxDelta']) {
            const before = f.state(),
                logs = f.store.db.prepare('SELECT * FROM request_log').all()
            assert.throws(() => f.call('MailClaim', claim(), failed), /mailbox-codec-failure/)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(f.store.db.prepare('SELECT * FROM request_log').all(), logs)
        }
        const before = f.state()
        assert.throws(
            () => f.call('StartMailClaimAll', { request_seq: '1' }, 'cs.SCMailClaimAllUpdate'),
            /mailbox-codec-failure/,
        )
        assert.deepEqual(f.state(), before)
        f.mutate((s) =>
            s.mail.push(mail({ guid: '2', reward: { rewards: [{ itemtype: 99999, itemid: 1, itemnum: 1 }] } })),
        )
        const malformed = f.state()
        assert.throws(() => f.call('StartMailClaimAll', { request_seq: '2' }))
        assert.deepEqual(f.state(), malformed)
    } finally {
        f.close()
    }
})

test('actual SQLite reopen preserves mail fetch proof, per-claim replay and operation receipts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-mailbox-')),
        filename = path.join(directory, 'mail.sqlite')
    let f = fixture([mail()], filename)
    try {
        const first = f.call('MailClaim', claim()).response
        f.close()
        f = fixture([], filename)
        assert.deepEqual(f.call('MailClaim', claim()).response, first)
        assert.equal(f.state().player.basic_info.gold, 7)
        assert.equal(f.state().mail[0].fetch, true)
    } finally {
        f.close()
        const resolved = fs.realpathSync(directory)
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
        assert.ok(path.basename(resolved).startsWith('lurukaps-mailbox-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

test('malformed duplicate saved identities are configuration errors and cannot silently clear old mail', () => {
    const f = fixture([mail(), mail()])
    try {
        const before = f.state()
        assert.throws(
            () => f.call('GetMailboxSummary'),
            (e) => e.code === ErrorCode.MailConfigError,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('partial claim-all capacity failure discards the failed mail draft but commits independent successful mail', () => {
    const pet = tables.get('pet').find((row) => petModelEligibility(tables, row.id).eligible)
    const game = tables.get('game'),
        boxCount = Number(game.find((row) => row.title === 'PET_BOX_NUM').value),
        boxSize = Number(game.find((row) => row.title === 'PET_BOX_LIMIT').value)
    assert.ok(boxCount > 1)
    const f = fixture([
        mail(),
        mail({
            guid: '2',
            reward: {
                rewards: [
                    { itemtype: 10, itemid: 2, itemnum: 99 },
                    { itemtype: 5, itemid: pet.id, itemnum: 1 },
                ],
            },
        }),
    ])
    try {
        f.mutate((state) => {
            state.pets = Array.from({ length: boxSize }, (_, i) => ({ guid: String(i + 1), box_id: 101 + i }))
            state.lockedPetBoxes = Array.from({ length: boxCount - 1 }, (_, i) => i + 2)
        })
        const response = f.call('StartMailClaimAll', { request_seq: '1' }),
            packet = response.packets.find((p) => p.name === 'SCProtoMailClaimAllUpdate'),
            update = protocol.decode('cs.SCMailClaimAllUpdate', packet.payload)
        assert.equal(update.summary_code, Code.ClaimPartialCapacityFull)
        assert.equal(update.results.find((r) => r.mail_id === '2').code, Code.ClaimCapacityFull)
        assert.equal(f.state().player.basic_info.gold, 7)
        assert.equal(f.state().mail.find((m) => m.guid === '2').fetch, false)
        assert.equal(f.state().pets.length, boxSize)
    } finally {
        f.close()
    }
})

test('actual1.0 IL5906 vector omits claim_id; server issues exactly16 bytes and replays the same proof', () => {
    const f = fixture([mail()])
    try {
        const input = { selector: 1, mails: [{ mail_id: guid }], request_id: Buffer.alloc(16, 7).toString('base64') }
        const first = f.call('MailClaim', input).response
        assert.equal(first.results[0].code, Code.Ok)
        assert.equal(Buffer.from(first.results[0].claim_id, 'base64').length, 16)
        assert.equal(f.state().player.basic_info.gold, 7)
        assert.deepEqual(f.call('MailClaim', input).response, first)
        assert.equal(f.state().player.basic_info.gold, 7)
    } finally {
        f.close()
    }
})
