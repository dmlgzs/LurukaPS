import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ObtClientModel } from './helpers/obt-client-model.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const now = 1800000000
const frame = (id, data) => ({ id, payload: protocol.encode(protocol.byId.get(id).rsp, data) })
const decoded = (packets, id) =>
    protocol.decode(protocol.byId.get(id).rsp, packets.find((packet) => packet.id === id).payload)
function fixture(label, options = {}) {
    const store = new Store(':memory:'),
        session = {},
        model = new ObtClientModel(tables, protocol)
    const game = new Game(protocol, store, tables, { clock: () => now, ...options })
    let seq = 1
    const dispatch = (request, consume = true) => {
        const packets = game.dispatch(session, { ...request, seq: seq++ })
        if (consume) model.consumePackets(packets)
        return packets
    }
    const call = (name, request = {}, consume = true) => {
        const entry = protocol.byName.get('CSProto' + name)
        return dispatch(
            { id: entry.id, payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0) },
            consume,
        )
    }
    const initial = call('EnterGame', { open_id: `obt-consumer-${label}` })
    return { store, session, game, model, initial, call, dispatch, state: () => store.load(session.id).state }
}

test('real 5001 can populate current hero/formation references; codec-valid retired or unresolved references fail consumer lookup', () => {
    const f = fixture('hero')
    try {
        assert(f.model.assertHeroReferences() > 0)
        const payload = decoded(f.initial, 5001)
        const invalid = structuredClone(payload)
        invalid.data.heros_info.heros[0].conf_id = 999999999
        const badHero = new ObtClientModel(tables, protocol)
        badHero.consumePacket(frame(5001, invalid))
        assert.throws(() => badHero.assertHeroReferences(), /Client hero config is unavailable/)
        const broken = structuredClone(payload)
        const group = broken.data.group_mgrs.find((manager) => manager.type === 1).groups[0]
        group.control = '9007199254740993'
        const badGroup = new ObtClientModel(tables, protocol)
        badGroup.consumePacket(frame(5001, broken))
        assert.throws(() => badGroup.assertHeroReferences(), /Controlled hero is unavailable/)
    } finally {
        f.store.close()
    }
})

test('real attendance vehicle data and attributes arrive before reward ACK and remain resolvable during riding', () => {
    const f = fixture('vehicle')
    try {
        const attendance = tables.get('game_events').find((row) => row.type === 3 && row.systemId === 2001)
        f.store.transact(f.session.id, 0, (state) => {
            state.taskRecords ??= []
            state.taskRecords.push({ task_id: 106010, count: 1 })
            f.game.activities.snapshot(state, now)
            Object.assign(state.activities[attendance.id].sign, { count: 2, reward_count: 1 })
        })
        const packets = f.call('ActivityDailySign', { u32: attendance.id }, false)
        const ackId = protocol.byName.get('CSProtoActivityDailySign').id
        const reward = decoded(packets, ackId).rewards.find((reward) => reward.itemtype === 41)
        assert(reward?.guid)
        const ownership = packets.findIndex((packet) => packet.id === 6592)
        const attributes = packets.findIndex(
            (packet) => packet.id === 10006 && decoded([packet], 10006).heros.some((actor) => actor.type === 32),
        )
        const ack = packets.findIndex((packet) => packet.id === ackId)
        assert(ownership >= 0 && attributes > ownership && ack > attributes)
        for (const packet of packets) {
            f.model.consumePacket(packet)
            if (packet.id === ackId) assert.equal(f.model.assertVehicleReady(reward.guid).configId, reward.itemid)
        }
        f.call('WorldMapPlayerStatus', { status: 1, arg: reward.guid })
        assert(f.model.mountAttempts.length)
        assert(f.model.mountAttempts.every((attempt) => attempt.canCreate))

        // MountStore permits attribute pre-caching. It is use-before-config,
        // rather than mere packet reordering, that creates an empty mount.
        const reordered = new ObtClientModel(tables, protocol)
        reordered.consumePackets(f.initial)
        reordered.consumePacket(packets[attributes])
        assert.equal(reordered.resolveVehicle(reward.guid).canCreate, false)
        assert.throws(() => reordered.assertVehicleReady(reward.guid), /vehicle-config-missing/)
        reordered.consumePacket(packets[ownership])
        assert.equal(reordered.assertVehicleReady(reward.guid).configId, reward.itemid)
        reordered.consumePacket(packets[ownership])
        assert(reordered.assertVehicleReady(reward.guid).injectedAttributes.length)
        const earlyAck = new ObtClientModel(tables, protocol)
        earlyAck.consumePackets(f.initial)
        earlyAck.consumePacket(packets[ack])
        assert.throws(() => earlyAck.assertVehicleReady(reward.guid), /vehicle-not-cached/)
        const missingAttrs = new ObtClientModel(tables, protocol)
        missingAttrs.consumePacket(packets[ownership])
        assert.equal(missingAttrs.resolveVehicle(reward.guid).canCreate, true)
        assert.throws(() => missingAttrs.assertVehicleReady(reward.guid), /server attributes are not ready/)
        const badDefinition = decoded([packets[ownership]], 6592)
        badDefinition.owned_vehicles[0].conf_id = 999999999
        const invalid = new ObtClientModel(tables, protocol)
        invalid.consumePacket(frame(6592, badDefinition))
        assert.throws(() => invalid.assertVehicleReady(reward.guid), /vehicle-config-missing/)
    } finally {
        f.store.close()
    }
})

test('CutWorldFlow9151 notification resolves a real11055 table mode without a response or dungeon completion', () => {
    const f = fixture('scene')
    try {
        const city = tables.get('world_city').find((row) => row.type === 12)
        const dungeon = tables.get('dungeon').find((row) => row.dungeonType === 1)
        f.store.transact(f.session.id, 0, (state) => {
            state.world.map_id = city.id
            state.storyCampaign = { map_id: city.id, dungeon_id: dungeon.id, status: 2, consumer_test_marker: true }
        })
        const before = structuredClone(f.state().storyCampaign)
        const packets = f.dispatch(f.model.mapLoadFinishedRequest())
        assert(!packets.some((packet) => packet.id === 9151))
        assert(packets.some((packet) => packet.id === 11055))
        assert.equal(f.model.assertSceneModeConfigured().sceneTypeId, city.type)
        assert.deepEqual(f.state().storyCampaign, before)
        assert.equal(f.state().world.map_id, city.id)
        assert.throws(() => f.model.consumePacket({ id: 9151, payload: Buffer.alloc(0) }), /request-only/)
        f.model.consumePacket(frame(11055, { mode: 999999 }))
        assert.throws(() => f.model.assertSceneModeConfigured(), /no current table entry/)
    } finally {
        f.store.close()
    }
})

test('real summary list delta and native-style claim are accepted by the current mail consumer exactly once', () => {
    const f = fixture('mail')
    try {
        const id = '9007199254740993'
        f.store.transact(f.session.id, 0, (state) => {
            state.mail = [
                {
                    guid: id,
                    createtm: now - 10,
                    effecttm: 3600,
                    title: Buffer.from('client-contract').toString('base64'),
                    content: '',
                    sender_id: '',
                    read: false,
                    fetch: false,
                    collect: false,
                    reward: { rewards: [{ itemtype: 10, itemid: 2, itemnum: 7 }] },
                },
            ]
        })
        const summary = f.call('GetMailboxSummary', { known_mailbox_version: '0' })
        assert.equal(f.model.mailbox.version.toString(), decoded(summary, 5900).summary.mailbox_version)
        const page = f.call('ListMails', {
            list_type: 1,
            limit: 10,
            known_mailbox_version: f.model.mailbox.version.toString(),
        })
        assert(f.model.mailbox.mails.has(id))
        const beforeRead = f.model.mailbox.version
        const read = f.call('MailRead', { mail_id: id })
        assert(read.some((packet) => packet.id === 5907))
        assert.equal(f.model.mailbox.version, beforeRead + 1n)
        assert(f.model.mailbox.mails.get(id).read)
        assert(f.model.mailbox.events.some((event) => event.status === 'ignored'))
        const request = f.model.mailClaimRequest(id)
        assert.equal(Object.hasOwn(request.mails[0], 'claim_id'), false)
        const beforeGold = f.state().player.basic_info.gold
        const claim = f.call('MailClaim', request)
        const result = decoded(claim, 5906).results[0]
        assert.equal(Buffer.from(result.claim_id, 'base64').length, 16)
        assert.equal(result.status, 3)
        assert.equal(
            f.model.claimRewardViews.reduce((sum, reward) => sum + reward.itemnum, 0),
            7,
        )
        assert.equal(f.state().player.basic_info.gold - beforeGold, 7)
        f.call('MailClaim', request)
        assert.equal(f.model.claimRewardViews.length, 1)
        assert.equal(f.state().player.basic_info.gold - beforeGold, 7)

        const bad = new ObtClientModel(tables, protocol)
        bad.consumePackets([...f.initial, ...summary, ...page, ...read])
        const invalid = structuredClone(decoded(claim, 5906))
        invalid.results[0].claim_id = Buffer.alloc(15, 1).toString('base64')
        bad.consumePacket(frame(5906, invalid))
        assert.equal(bad.claimStates.size, 0)
        assert.equal(bad.claimRewardViews.length, 0)
        // The independent delta can mark mail claimed even when the UI result
        // merger discarded malformed proof. Codec success alone misses this.
        assert.equal(bad.mailbox.mails.get(id).claimed, true)
        const count = f.model.claimRewardViews.length
        assert.equal(f.model.mergeClaimResults([{ ...result, mail_id: '9007199254740995' }]), 0)
        assert.equal(f.model.claimRewardViews.length, count)
    } finally {
        f.store.close()
    }
})

test('mail version guards use uint64 precision and distinguish old deltas future gaps resets and summary alignment', () => {
    const model = new ObtClientModel(tables, protocol)
    const version = 9007199254740993n
    const summary = (value) => ({ mailbox_version: String(value), total_visible_count: 0 })
    const delta = (base, next) => ({ base_version: String(base), mailbox_version: String(next), changes: [] })
    model.consumePacket(frame(5907, { delta: delta(version, version + 1n) }))
    assert.equal(model.mailbox.version, undefined)
    assert.equal(model.mailbox.needsSummary, true)
    model.consumePacket(frame(5900, { code: 0, summary: summary(version) }))
    model.consumePacket(frame(5907, { delta: delta(version, version + 1n) }))
    assert.equal(model.mailbox.version, version + 1n)
    assert.equal(model.mailbox.events.at(-1).status, 'applied')
    model.consumePacket(frame(5907, { delta: delta(version, version + 100n) }))
    assert.equal(model.mailbox.events.at(-1).status, 'ignored')
    model.consumePacket(frame(5907, { delta: delta(version + 2n, version + 3n) }))
    assert.equal(model.mailbox.events.at(-1).status, 'resync')
    model.consumePacket(frame(5907, { delta: delta(version + 1n, version + 3n) }))
    assert.equal(model.mailbox.events.at(-1).status, 'resync')
    assert.equal(model.mailbox.version, version + 1n)
    model.consumePacket(frame(5900, { summary: summary(version + 9n) }))
    assert.equal(model.mailbox.version, version + 1n)
    assert.equal(model.mailbox.needsSync, true)
    model.consumePacket(
        frame(5907, {
            delta: { reset_required: true, mailbox_version: String(version + 9n), summary: summary(version + 9n) },
        }),
    )
    assert.equal(model.mailbox.version, version + 9n)
    assert.equal(model.mailbox.events.at(-1).status, 'reset')
})

test('real gift-code delivery bridge publishes a consumable5907 upsert before the new mail can be claimed', () => {
    const f = fixture('mail-delivery', {
        giftCodeConfig: {
            schema_version: 1,
            mode: 'local-configured-mail',
            codes: [
                {
                    id: 'consumer-mail',
                    code: 'CLIENT-CONTRACT',
                    starts_at: now - 1,
                    ends_at: now + 60,
                    minimum_level: 1,
                    mail: { sender: 'test', title: 'test', content: 'test', duration: 3600 },
                    rewards: [{ itemtype: 10, itemid: 2, itemnum: 9 }],
                },
            ],
        },
    })
    try {
        f.call('GetMailboxSummary', { known_mailbox_version: '0' })
        const before = f.model.mailbox.version
        const delivered = f.call('ExchangeGiftCode', { code: 'CLIENT-CONTRACT' })
        assert(delivered.some((packet) => packet.id === 5907))
        assert.equal(f.model.mailbox.version, before + 1n)
        assert.equal(f.model.mailbox.mails.size, 1)
        const mail = [...f.model.mailbox.mails.values()][0]
        assert(BigInt(mail.mail_id) > BigInt(Number.MAX_SAFE_INTEGER))
        assert.equal(mail.reward.rewards[0].itemnum, 9)
        f.call('MailClaim', f.model.mailClaimRequest(mail.mail_id))
        assert.equal(f.model.claimRewardViews[0].itemnum, 9)
        assert.equal(f.model.mailbox.mails.get(mail.mail_id).claimed, true)
    } finally {
        f.store.close()
    }
})

test('claim merger ignores non16-byte proofs invalid states state regressions and terminal replays', () => {
    const model = new ObtClientModel(tables, protocol)
    const result = { mail_id: '9007199254740993', claim_id: Buffer.alloc(16, 3).toString('base64'), status: 2 }
    assert.equal(model.mergeClaimResults([{ ...result, claim_id: Buffer.alloc(17).toString('base64') }]), 0)
    assert.equal(model.mergeClaimResults([{ ...result, status: 0 }]), 0)
    assert.equal(model.mergeClaimResults([result]), 1)
    assert.equal(model.mergeClaimResults([{ ...result, status: 1 }]), 0)
    assert.equal(
        model.mergeClaimResults([
            { ...result, status: 3, rewards: { rewards: [{ itemtype: 10, itemid: 2, itemnum: 1 }] } },
        ]),
        1,
    )
    assert.equal(model.mergeClaimResults([{ ...result, status: 4 }]), 0)
    assert.equal(model.claimRewardViews.length, 1)
})

test('current trial hero consumer uses GUID interim configuration and resolves protagonist trials by actual player sex', () => {
    const ordinary = tables.get('hero_interim').find((row) => row.heroType !== 1 && tables.find('hero', row.heroId))
    const main = tables.get('hero_interim').find((row) => row.heroType === 1)
    assert(ordinary && main)
    for (const [sex, explicit] of [
        [1, true],
        [1, false],
        [2, true],
        [2, false],
    ]) {
        const model = new ObtClientModel(tables, protocol)
        const heroes = [ordinary, main].map((row) => ({
            guid: ((5n << 56n) | (BigInt(row.id) << 32n) | 1n).toString(),
            conf_id: 999999999,
            ...(explicit ? { trail: true } : {}),
        }))
        model.consumePacket(frame(5001, { data: { basic_info: { sex }, heros_info: { heros: heroes } } }))
        assert.equal(model.assertHeroReferences(), 2)
    }
})
