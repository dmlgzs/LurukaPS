import test from 'node:test'
import assert from 'node:assert/strict'
import { petCosmeticsFixture } from './pet-cosmetics-fixture.js'

test('legacy mail producers deliver current5907 immediately and current5906 claims once across reconnect', () => {
    const f = petCosmeticsFixture('obt-mail-delivery-bridge')
    try {
        const initial = f.decode(f.call('GetMailboxSummary'), 5900).summary
        const guid = '9007199254740993'
        const now = Math.floor(Date.now() / 1000)
        const mail = {
            guid,
            createtm: now,
            effecttm: 86400,
            title: Buffer.from('title').toString('base64'),
            content: Buffer.from('content').toString('base64'),
            sender_id: Buffer.from('sender').toString('base64'),
            reward: { rewards: [{ itemtype: 10, itemid: 2, itemnum: 7 }] },
        }
        const entry = f.protocol.byName.get('CSProtoWorldTimeSync')
        const original = f.game.handlers.get(entry.id)
        f.game.handlers.set(entry.id, (c, r) => {
            const response = original(c, r)
            c.state.mail.push(structuredClone(mail))
            // Gift-code and existing delivery services still use this internal
            // notification; the Game adapter must produce the current wire.
            c.pushBefore('CSProtoMailSync', { mails: [mail] })
            return response
        })
        const delivered = f.call('WorldTimeSync', { world_time: 1200 })
        const delta = f.decode(delivered, 5907).delta
        assert.equal(delta.base_version, initial.mailbox_version)
        assert.equal(BigInt(delta.mailbox_version), BigInt(delta.base_version) + 1n)
        assert(delivered.findIndex((p) => p.id === 5907) < delivered.findIndex((p) => p.id === entry.id))
        assert(delta.changes.some((change) => change.mail_id === guid))
        const request = { selector: 1, mails: [{ mail_id: guid }], request_id: Buffer.alloc(16, 9).toString('base64') }
        const gold = f.state().player.basic_info.gold
        const first = f.decode(f.call('MailClaim', request), 5906)
        assert.equal(first.results[0].code, 0)
        assert.equal(Buffer.from(first.results[0].claim_id, 'base64').length, 16)
        assert.equal(f.state().player.basic_info.gold, gold + 7)
        const reconnected = {}
        f.login(reconnected)
        assert.deepEqual(f.decode(f.call('MailClaim', request, reconnected), 5906), first)
        assert.equal(f.state().player.basic_info.gold, gold + 7)
    } finally {
        f.store.close()
    }
})
