import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { soulDecomposePlan } from '../src/soul-decompose.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'

const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    now = 1800000000
function fixture(t, name) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-zero-soul-current-')),
        filename = path.join(directory, 'synthetic.sqlite'),
        tables = new Tables(cfg.tables)
    let store,
        game,
        session,
        client,
        seq = 1
    t.after(() => {
        store?.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const state = () => store.load(session.id).state
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
        client.consumePackets(packets)
        return packets
    }
    const reopen = () => {
        store?.close()
        store = new Store(filename)
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
        session = {}
        client = new ObtInventoryConsumer(tables, protocol)
        return call('EnterGame', { open_id: 'zero-soul-current-' + name })
    }
    reopen()
    assert.equal(state().starterProfile.mode, 'normal')
    assert.equal(state().player.soulessence_infos.soulessences.length, 0)
    const grant = (ids) => {
        const old = new Set(state().player.soulessence_infos.soulessences.map((item) => item.guid))
        call('GMCommands', { cmds: ids.map((id) => ({ command: Buffer.from(`give 9 ${id} 1`).toString('base64') })) })
        return state().player.soulessence_infos.soulessences.filter((item) => !old.has(item.guid))
    }
    const onAck = (verify) => client.onAck('DecomposeSoulEssence', (_cache, response) => verify(response))
    return {
        tables,
        get store() {
            return store
        },
        get session() {
            return session
        },
        get client() {
            return client
        },
        state,
        call,
        reopen,
        grant,
        onAck,
    }
}
const assetState = (f) => ({
    bag: f.state().player.sbag_infos,
    pets: f.state().pets,
    eggs: f.state().petEggs,
    gold: f.state().player.basic_info.gold,
    diamond: f.state().player.basic_info.diamond,
    nextItemGuid: f.state().nextItemGuid,
    nextEssenceGuid: f.state().nextEssenceGuid,
})
const reject = (f, fn, code) => {
    const before = f.store.load(f.session.id),
        logs = f.store.db.prepare('SELECT * FROM request_log').all()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(f.store.db.prepare('SELECT * FROM request_log').all(), logs)
}
function checkDeletionBeforeAck(packets, guids) {
    const ack = packets.findIndex((packet) => packet.id === 6051)
    assert(ack >= 0)
    const removed = packets.slice(0, ack).flatMap((packet) => {
        const entry = protocol.byId.get(packet.id)
        return entry.name === 'CSProtoSyncPlayerData'
            ? (protocol.decode(entry.rsp, packet.payload).soulessence_infos?.del_pos ?? [])
            : []
    })
    assert(guids.every((guid) => removed.includes(guid)))
}

test('both current empty-refund definitions delete only confirmed unlocked GUIDs before6051ACK and retain unrelated assets across cold login', (t) => {
    const f = fixture(t, 'both'),
        zero = f.tables.get('soulessence').filter((row) => row.rarity !== 4 && row.decomposed === '')
    assert.deepEqual(
        zero.map((row) => row.id).sort((a, b) => a - b),
        [10098, 10123],
    )
    const granted = f.grant([...zero.map((row) => row.id), 10044]),
        guids = granted.slice(0, 2).map((item) => item.guid),
        retained = granted.at(-1)
    f.call('SetLockSoulEssence', { guids, lock: false })
    const assets = structuredClone(assetState(f))
    let called = false
    f.onAck((response) => {
        called = true
        assert.deepEqual(response.rewards, [])
        assert(guids.every((guid) => !f.client.souls.has(String(guid))))
        assert.deepEqual(f.client.souls.get(String(retained.guid)), {
            ...f.client.souls.get(String(retained.guid)),
            ...retained,
        })
    })
    const packets = f.call('DecomposeSoulEssence', { guids })
    assert(called)
    checkDeletionBeforeAck(packets, guids)
    assert.deepEqual(f.state().player.soulessence_infos.soulessences, [retained])
    assert.deepEqual(assetState(f), assets)
    reject(f, () => f.call('DecomposeSoulEssence', { guids }), ErrorCode.SoulEssenceNotExist)
    f.reopen()
    assert.deepEqual(f.state().player.soulessence_infos.soulessences, [retained])
    assert.deepEqual(assetState(f), assets)
    assert.equal(f.client.souls.size, 1)
    assert(f.client.souls.has(String(retained.guid)))
    // A mixed current batch returns only the ordinary selected item's own data.
    const [extra] = f.grant([zero[0].id])
    f.call('SetLockSoulEssence', { guids: [extra.guid, retained.guid], lock: false })
    const expected = f.tables
        .find('soulessence', retained.id)
        .decomposed.split('|')
        .map((token) => {
            const [itemtype, itemid, itemnum] = token.split('#').map(Number)
            return { itemtype, itemid, itemnum }
        })
    const beforeBag = new Map(expected.map((r) => [r.itemid, f.client.count(r.itemid)]))
    f.onAck((response) => {
        assert.deepEqual(
            response.rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
            expected,
        )
        assert(!f.client.souls.has(String(extra.guid)))
        assert(!f.client.souls.has(String(retained.guid)))
        for (const r of expected) assert.equal(f.client.count(r.itemid), beforeBag.get(r.itemid) + r.itemnum)
    })
    checkDeletionBeforeAck(f.call('DecomposeSoulEssence', { guids: [extra.guid, retained.guid] }), [
        extra.guid,
        retained.guid,
    ])
    assert.equal(f.state().player.soulessence_infos.soulessences.length, 0)
})

test('zero-refund last-owned item preserves full state and SQL on codec/write failures then deletes once and stays absent after cold login', (t) => {
    const f = fixture(t, 'rollback'),
        [item] = f.grant([10123])
    f.call('SetLockSoulEssence', { guids: [item.guid], lock: false })
    const before = f.store.load(f.session.id),
        logs = f.store.db.prepare('SELECT * FROM request_log').all(),
        encode = protocol.encode
    protocol.encode = function (name, value) {
        if (name === 'cs.Rewards') throw Error('zero-soul-codec')
        return encode.call(this, name, value)
    }
    try {
        assert.throws(() => f.call('DecomposeSoulEssence', { guids: [item.guid] }), /zero-soul-codec/)
    } finally {
        protocol.encode = encode
    }
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(f.store.db.prepare('SELECT * FROM request_log').all(), logs)
    assert(f.client.souls.has(String(item.guid)))
    f.store.db.exec(
        "CREATE TEMP TRIGGER zero_soul_failure BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'zero-soul-sql'); END",
    )
    try {
        assert.throws(() => f.call('DecomposeSoulEssence', { guids: [item.guid] }), /zero-soul-sql/)
    } finally {
        f.store.db.exec('DROP TRIGGER zero_soul_failure')
    }
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(f.store.db.prepare('SELECT * FROM request_log').all(), logs)
    const assets = structuredClone(assetState(f))
    let closed = false
    f.onAck((response) => {
        assert.deepEqual(response.rewards, [])
        assert.equal(f.client.souls.size, 0)
        closed = true
    })
    checkDeletionBeforeAck(f.call('DecomposeSoulEssence', { guids: [item.guid] }), [item.guid])
    assert(closed)
    assert.deepEqual(assetState(f), assets)
    reject(f, () => f.call('DecomposeSoulEssence', { guids: [item.guid] }), ErrorCode.SoulEssenceNotExist)
    f.reopen()
    assert.equal(f.state().player.soulessence_infos.soulessences.length, 0)
    assert.equal(f.client.souls.size, 0)
    assert.deepEqual(assetState(f), assets)
})

test('empty string does not relax locks or worn guards, and missing/nonstring/malformed refund data remains strict', (t) => {
    const f = fixture(t, 'strict'),
        [item] = f.grant([10098]),
        row = f.tables.find('soulessence', item.id),
        original = row.decomposed
    reject(f, () => f.call('DecomposeSoulEssence', { guids: [item.guid] }), ErrorCode.LockSoulEssence)
    f.call('SetLockSoulEssence', { guids: [item.guid], lock: false })
    const hero = f.state().player.heros_info.heros[0]
    f.call('MoveSoulEssence', { hero_id: hero.guid, guid: item.guid })
    reject(f, () => f.call('DecomposeSoulEssence', { guids: [item.guid] }), ErrorCode.SoulEssenceOnWear)
    f.call('MoveSoulEssence', { hero_id: hero.guid, guid: 0 })
    try {
        for (const invalid of [undefined, null, 0, [], {}, '|', '||', 'broken', '3#400002#0', '3#4294967295#1']) {
            if (invalid === undefined) delete row.decomposed
            else row.decomposed = invalid
            if (invalid === '|' || invalid === '||')
                assert.throws(
                    () => soulDecomposePlan(f.tables, f.state(), [item.guid]),
                    (error) => error.code === ErrorCode.GameConfig,
                )
            reject(f, () => f.call('DecomposeSoulEssence', { guids: [item.guid] }), ErrorCode.GameConfig)
        }
    } finally {
        row.decomposed = original
    }
    const [rarity4] = f.grant([10032])
    f.call('SetLockSoulEssence', { guids: [rarity4.guid], lock: false })
    reject(f, () => f.call('DecomposeSoulEssence', { guids: [rarity4.guid] }), ErrorCode.InvalidArgument)
    assert.equal(f.state().player.soulessence_infos.soulessences.length, 2)
})
