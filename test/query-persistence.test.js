import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const queryNames = ['GetMailboxSummary', 'ListMails', 'SyncMailbox', 'ShopInfoReq', 'ListShopArrayItems'],
    queryIds = new Set(queryNames.map((name) => protocol.byName.get('CSProto' + name).id))
function sample(store, id) {
    return {
        ...store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(id),
        changes: store.db.prepare('SELECT total_changes() AS n').get().n,
        logs: store.db.prepare('SELECT count(*) AS n FROM request_log').get().n,
    }
}
function unchanged(before, after) {
    assert.deepEqual(after, before)
}
function changed(before, after) {
    assert.equal(after.revision, before.revision + 1)
    assert.equal(after.changes, before.changes + 2)
    assert.equal(after.logs, before.logs + 1)
}
function smallStore() {
    const store = new Store(':memory:'),
        { id } = store.login('query-store', () => ({ value: 1 }))
    return { store, id }
}
function fixture(name) {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now }),
        transact = store.transact.bind(store)
    // Mirrors the proposed Game allowlist without changing Game under another
    // owner's feet. Everything else runs the actual production transaction.
    store.transact = (id, messageId, fn, options) =>
        transact(id, messageId, fn, { ...options, skipUnchanged: queryIds.has(messageId) })
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        const packets = game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        })
        const reply = packets.find((packet) => packet.id === entry.id)
        return reply ? protocol.decode(entry.rsp, reply.payload) : undefined
    }
    call('EnterGame', { open_id: `query-persistence-${name}` })
    return {
        store,
        session,
        game,
        call,
        advance: (seconds) => (now += seconds),
        now: () => now,
        state: () => store.load(session.id).state,
    }
}

test('skipUnchanged is opt-in and returns encoded results without writes, success logs or token invalidation', () => {
    const { store, id } = smallStore()
    try {
        const before = sample(store, id),
            token = store.readCacheToken(id),
            packet = Buffer.from('wire-payload')
        const value = store.transact(id, 5900, () => packet, { skipUnchanged: true })
        assert.equal(value, packet)
        unchanged(before, sample(store, id))
        assert.equal(store.readCacheToken(id), token)
        store.transact(id, 5900, () => packet)
        changed(before, sample(store, id))
        assert.notEqual(store.readCacheToken(id), token)
    } finally {
        store.close()
    }
})

test('unchanged queries preserve deferred state and logs until the actual flush', () => {
    const { store, id } = smallStore()
    try {
        const before = sample(store, id)
        store.transact(id, 11230, (state) => (state.value = 2), { defer: true, logDeferred: true })
        const pending = store.pending.get(id),
            token = store.readCacheToken(id)
        store.transact(id, 5900, (state) => assert.equal(state.value, 2), { skipUnchanged: true })
        unchanged(before, sample(store, id))
        assert.equal(store.pending.get(id), pending)
        assert.equal(store.readCacheToken(id), token)
        assert.equal(store.load(id).state.value, 2)
        assert.equal(pending.logs.length, 1)
        store.flushPending()
        changed(before, sample(store, id))
        assert.equal(JSON.parse(sample(store, id).state).value, 2)
        assert.equal(store.pending.size, 0)
        assert.notEqual(store.readCacheToken(id), token)
    } finally {
        store.close()
    }
})

test('actual state changes and related-account edits remain durable even when the main state is unchanged', () => {
    const { store, id } = smallStore()
    try {
        const initial = sample(store, id),
            token = store.readCacheToken(id)
        store.transact(id, 5900, (state) => (state.value = 3), { skipUnchanged: true })
        changed(initial, sample(store, id))
        assert.notEqual(store.readCacheToken(id), token)
        const { id: peer } = store.login('query-related', () => ({ value: 10 }))
        store.transact(peer, 11230, (state) => (state.value = 11), { defer: true, logDeferred: true })
        const before = sample(store, id),
            peerBefore = sample(store, peer)
        store.transact(id, 5900, (_, { editPlayer }) => (editPlayer(peer).value = 12), { skipUnchanged: true })
        assert.equal(sample(store, id).revision, before.revision + 1)
        assert.equal(sample(store, peer).revision, peerBefore.revision + 1)
        assert.equal(sample(store, id).changes, before.changes + 5)
        assert.equal(sample(store, id).logs, before.logs + 3)
        assert.equal(store.load(id).state.value, 3)
        assert.equal(store.load(peer).state.value, 12)
        assert.equal(store.pending.has(peer), false)
    } finally {
        store.close()
    }
})

test('observer failures and actual codec rejection roll back drafts, related edits and cache tokens', () => {
    const { store, id } = smallStore()
    try {
        const { id: peer } = store.login('query-rollback-related', () => ({ value: 10 }))
        store.transact(id, 11230, (state) => (state.value = 2), { defer: true })
        const before = sample(store, id),
            peerBefore = sample(store, peer),
            pending = store.pending.get(id),
            token = store.readCacheToken(id)
        assert.throws(
            () =>
                store.transact(
                    id,
                    5900,
                    (state, { editPlayer }) => {
                        state.value = 4
                        editPlayer(peer).value = 20
                        throw Error('observer failed')
                    },
                    { skipUnchanged: true },
                ),
            /observer failed/,
        )
        assert.throws(
            () =>
                store.transact(
                    id,
                    5900,
                    (state, { editPlayer }) => {
                        state.value = 5
                        editPlayer(peer).value = 30
                        return protocol.encode('cs.SCGetMailboxSummary', { unknown_field: 1 })
                    },
                    { skipUnchanged: true },
                ),
            /Unknown field/,
        )
        unchanged(before, sample(store, id))
        unchanged(peerBefore, sample(store, peer))
        assert.equal(store.pending.get(id), pending)
        assert.equal(store.load(id).state.value, 2)
        assert.equal(store.readCacheToken(id), token)
    } finally {
        store.close()
    }
})

test('real Game query initialization including battle-pass observation is durable; repeated warm mailbox/shop queries have zero durable effects', () => {
    const f = fixture('warm')
    try {
        const id = f.session.id,
            before = sample(f.store, id),
            first = f.call('GetMailboxSummary', { known_mailbox_version: '0' }),
            after = sample(f.store, id)
        changed(before, after)
        assert.notDeepEqual(JSON.parse(before.state).battlePass, JSON.parse(after.state).battlePass)
        const version = first.summary.mailbox_version,
            token = f.store.readCacheToken(id)
        let loads = 0
        const load = f.store.load.bind(f.store)
        f.store.load = (...args) => {
            loads++
            return load(...args)
        }
        for (let index = 0; index < 3; index++) {
            assert.equal(
                f.call('GetMailboxSummary', { known_mailbox_version: version }).summary.mailbox_version,
                version,
            )
            assert.equal(f.call('ListMails', { list_type: 1, limit: 30, known_mailbox_version: version }).code, 0)
            assert.deepEqual(f.call('SyncMailbox', { since_version: version, max_deltas: 100 }).deltas, [])
            f.call('ShopInfoReq', { shop_id: tables.get('shop')[0].shopId })
            f.call('ListShopArrayItems', { shop_ids: [tables.get('shop')[0].shopId] })
        }
        unchanged(after, sample(f.store, id))
        assert.equal(loads, 15, 'The guard removes persistence, not the normal transaction observers/read')
        assert.equal(f.store.readCacheToken(id), token)
    } finally {
        f.store.close()
    }
})

test('real mailbox visibility, expiry, delivery and reward claims keep version progress and durable atomic awards', () => {
    const f = fixture('mail-boundaries')
    try {
        const id = f.session.id,
            mail = (guid, fields = {}) => ({
                guid,
                createtm: f.now(),
                title: '',
                content: '',
                read: false,
                fetch: false,
                collect: false,
                reward: { rewards: [] },
                ...fields,
            })
        f.store.transact(id, 0, (state) => {
            delete state.mailboxV1
            state.mail = [mail('9007199254740993', { effecttm: 2 })]
        })
        let before = sample(f.store, id)
        const first = f.call('GetMailboxSummary')
        changed(before, sample(f.store, id))
        assert.equal(first.summary.total_visible_count, 1)
        f.advance(2)
        before = sample(f.store, id)
        const expired = f.call('GetMailboxSummary')
        changed(before, sample(f.store, id))
        assert.equal(expired.summary.total_visible_count, 0)
        assert.equal(BigInt(expired.summary.mailbox_version), BigInt(first.summary.mailbox_version) + 1n)
        f.store.transact(id, 0, (state) => state.mail.push(mail('9007199254740994', { visible_time: f.now() + 2 })))
        before = sample(f.store, id)
        assert.equal(f.call('GetMailboxSummary').summary.total_visible_count, 0)
        unchanged(before, sample(f.store, id))
        f.advance(2)
        before = sample(f.store, id)
        assert.equal(f.call('GetMailboxSummary').summary.total_visible_count, 1)
        changed(before, sample(f.store, id))
        const item = tables.find('common_item', 400002)
        assert(item)
        const owned = () =>
                f
                    .state()
                    .player.sbag_infos.items.filter((row) => row.itemid === item.id)
                    .reduce((sum, row) => sum + row.itemnum, 0),
            count = owned()
        f.store.transact(id, 0, (state) =>
            state.mail.push(
                mail('9007199254740995', { reward: { rewards: [{ itemtype: 3, itemid: item.id, itemnum: 2 }] } }),
            ),
        )
        before = sample(f.store, id)
        f.call('GetMailboxSummary')
        changed(before, sample(f.store, id))
        const request = {
            selector: 1,
            request_id: Buffer.alloc(16, 1).toString('base64'),
            mails: [{ mail_id: '9007199254740995' }],
        }
        before = sample(f.store, id)
        assert.equal(f.call('MailClaim', request).results[0].status, 3)
        changed(before, sample(f.store, id))
        assert.equal(owned(), count + 2)
        const awarded = sample(f.store, id)
        f.call('GetMailboxSummary')
        unchanged(awarded, sample(f.store, id))
        f.call('MailClaim', request)
        changed(awarded, sample(f.store, id))
        assert.equal(owned(), count + 2)
    } finally {
        f.store.close()
    }
})
