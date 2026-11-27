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
import { startServer } from '../src/server.js'
import { ErrorCode } from '../src/error-codes.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { connectObtGcmClient } from './helpers/obt-gcm-client.js'
import { fundCurrentCombatActors, qualifyCurrentCombatWorld } from './combat-normal-current-fixture.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
const skill = 1070030113 // Current reported Abby timeline; parent10700313 is her configured ultimate.
assert.equal(tables.find('skill', skill).parentSkill, 10700313)
const request = (state) => ({
    uuid: state.player.heros_info.heros.find((hero) => hero.conf_id === 107003).guid,
    skill_id: skill,
    pos: { x: -915, y: 2732, z: -6892 },
    rotation: { y: 7554 },
})
function fixture(name) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let sequence = 1
    const call = (name, value) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, value) })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (state) => {
        assert.equal(state.starterProfile.mode, 'normal')
        assert.equal(state.player.heros_info.heros.length, 1)
        // Explicit current-factory qualification for the configured Abby
        // timeline, not an assumption that every new account owns all heroes.
        fundCurrentCombatActors(tables, state, { heroes: [107003] })
    })
    return { protocol, store, session, game, call, state: () => store.load(session.id).state }
}
function sql(f) {
    return {
        player: f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
        requests: f.store.db.prepare('SELECT * FROM request_log ORDER BY id').all(),
        sequences: f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
    }
}
// Current OnSCProtoSkillTimelinePosInfo0600079e -> SkillSyncInfo0600b5f6;
// StartTimeline0600c740 only consumes remote poses, and matching stop clears it.
class TimelineConsumer {
    constructor(uuid, mainControl = false) {
        this.uuid = uuid
        this.mainControl = mainControl
        this.pose = { x: 8, y: 9, z: 10 }
        this.info = null
    }
    receive(value) {
        if (value.uuid !== this.uuid) return
        const vector = (v) => Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, (v?.[axis] ?? 0) / 100]))
        this.info = { skill: value.skill_id, pos: vector(value.pos), rotation: vector(value.rotation) }
    }
    start() {
        if (!this.mainControl && !this.info) return false
        if (!this.mainControl) this.pose = structuredClone(this.info.pos)
        return true
    }
    stop(id) {
        if (this.info?.skill === id) this.info = null
    }
}

test('current11122 relays11123 without an ACK or any player,combat,pose,SQL or pending mutation', () => {
    const f = fixture('current-skill-timeline-relay')
    try {
        const before = f.store.load(f.session.id),
            raw = sql(f),
            pending = f.store.pending.get(f.session.id)
        const value = request(before.state)
        const packets = f.call('SkillTimelinePosInfo', value)
        assert(!f.protocol.byName.get('CSProtoSkillTimelinePosInfo').rsp)
        assert.equal(packets.length, 1)
        assert.equal(packets[0].id, 11123)
        assert.deepEqual(packets[0].audience, { kind: 'map', map: before.state.world.map_id, sender: f.session.id })
        const data = f.protocol.decode(f.protocol.byId.get(11123).rsp, packets[0].payload)
        assert.deepEqual(data, value)
        const remote = new TimelineConsumer(value.uuid),
            owner = new TimelineConsumer(value.uuid, true)
        assert.equal(remote.start(), false)
        remote.receive(data)
        owner.receive(data)
        assert.equal(remote.start(), true)
        owner.start()
        assert.deepEqual(remote.pose, { x: -9.15, y: 27.32, z: -68.92 })
        assert.deepEqual(owner.pose, { x: 8, y: 9, z: 10 })
        remote.stop(skill + 1)
        assert(remote.info)
        remote.stop(skill)
        assert.equal(remote.info, null)
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(sql(f), raw)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
    } finally {
        f.store.close()
    }
})

test('invalid/foreign timeline data cannot forward another actor or mutate saved state', () => {
    const f = fixture('current-skill-timeline-invalid')
    try {
        const valid = request(f.state())
        const foreign = ((1n << 56n) | (107003n << 32n) | 0xffffffffn).toString()
        for (const value of [
            { ...valid, uuid: '0' },
            { ...valid, uuid: foreign },
            { ...valid, skill_id: 0 },
            { ...valid, skill_id: 0xffffffff },
            { ...valid, pos: undefined },
            { ...valid, rotation: undefined },
        ]) {
            const before = f.store.load(f.session.id),
                raw = sql(f)
            assert.throws(
                () => f.call('SkillTimelinePosInfo', value),
                (error) => [ErrorCode.InvalidArgument, ErrorCode.InvalidTarget].includes(error.code),
            )
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.deepEqual(sql(f), raw)
        }
    } finally {
        f.store.close()
    }
})

test('timeline notification encoder failure publishes no pose or borrowed-state mutation and a retry succeeds', () => {
    const f = fixture('current-skill-timeline-codec')
    const encode = f.protocol.encode.bind(f.protocol)
    try {
        const before = f.store.load(f.session.id),
            raw = sql(f),
            type = f.protocol.byId.get(11123).rsp
        f.protocol.encode = (name, ...args) => {
            if (name === type) throw Error('timeline-notify-codec')
            return encode(name, ...args)
        }
        assert.throws(() => f.call('SkillTimelinePosInfo', request(before.state)), /timeline-notify-codec/)
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(sql(f), raw)
        f.protocol.encode = encode
        assert.equal(f.call('SkillTimelinePosInfo', request(before.state))[0].id, 11123)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('an admitted unhurt scene actor can relay a timeline without creating an HP entry; a released lease drops late visuals', () => {
    const f = fixture('current-skill-timeline-aoi')
    try {
        f.call('TrialGroupChange', { open: true, trial_id: 1 })
        f.call('TaskClientBefore', { task_id: 106001, node_id: 5 })
        const id = ((4n << 56n) | 10600101n).toString()
        const appearance = f.call('TryCreateWorldObj', { objs: [id] })
        assert(appearance.some((packet) => packet.id === 11063))
        assert.equal(f.state().combat.entities[id], undefined)
        const definition = enemyDefinition(tables, f.state(), id)
        const actorConfig = tables.find('enemy', definition.config_id)
        const root = Number(String(actorConfig.skillList).split('|')[0].split('#')[1])
        const program = tables.get('skill').find((row) => row.id === root || row.parentSkill === root)?.id ?? root
        assert(tables.find('skill', program) || tables.get('skill_level').some((row) => row.skillId === program))
        const value = { uuid: id, skill_id: program, pos: { ...f.state().world.pos }, rotation: {} }
        const before = f.store.load(f.session.id),
            raw = sql(f)
        assert.equal(f.call('SkillTimelinePosInfo', value)[0].id, 11123)
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(sql(f), raw)
        f.call('TryDeleteWorldObj', { u64s: [id] })
        const released = f.store.load(f.session.id),
            releasedSql = sql(f)
        assert.deepEqual(f.call('SkillTimelinePosInfo', value), [])
        assert.deepEqual(f.store.load(f.session.id), released)
        assert.deepEqual(sql(f), releasedSql)
    } finally {
        f.store.close()
    }
})

test('real GCM peers receive the current camera pose only in the map; the owner is never echoed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-timeline-'))
    const clients = []
    let server
    try {
        server = await startServer(
            {
                ...cfg,
                host: '127.0.0.1',
                publicHost: '127.0.0.1',
                gamePort: 0,
                httpPort: 0,
                database: path.join(directory, 'network.sqlite'),
                diagnosticsFile: path.join(directory, 'diagnostics.jsonl'),
                crcDelay: 0,
                strongEncryption: true,
                entryWorldChatNoticeDelayMs: 3600000,
            },
            { info() {}, warn() {} },
        )
        server.game.clock = () => 1800000000
        const entries = []
        for (const name of ['timeline-owner', 'timeline-peer', 'timeline-other-map']) {
            const client = await connectObtGcmClient(server)
            clients.push(client)
            const logged = await client.login(name)
            assert.equal(logged.entered.frame.error, 0)
            await client.barrier()
            entries.push({ client, id: logged.playerId })
        }
        const [owner, peer, other] = entries
        // Explicit public-world qualification for a peer-delivery scenario.
        // Equal private maps cannot authorize a broadcast after scene isolation.
        for (const entry of entries)
            server.store.transact(entry.id, 0, (state) => {
                assert.equal(state.starterProfile.mode, 'normal')
                qualifyCurrentCombatWorld(tables, state)
                if (entry === owner) fundCurrentCombatActors(tables, state, { heroes: [107003] })
            })
        const state = server.store.load(owner.id).state
        assert.equal(tables.find('world_city', state.world.map_id).type, 1)
        server.store.transact(peer.id, 0, (s) => {
            s.world.map_id = state.world.map_id
        })
        server.store.transact(other.id, 0, (s) => {
            s.world.map_id = state.world.map_id === 100 ? 101 : 100
        })
        const value = request(state),
            target = server.protocol.byId.get(11123)
        const before = entries.map(({ id }) => server.store.load(id))
        // No-response sender: current SendMessage11122 has no callback/request ACK.
        await owner.client.transmit(owner.client.encode('SkillTimelinePosInfo', value))
        await owner.client.barrier()
        await peer.client.until(() => peer.client.queue.some((frame) => frame.id === 11123))
        await other.client.barrier()
        const frame = peer.client.queue.find((entry) => entry.id === 11123)
        assert.equal(frame.error, 0)
        assert.equal(frame.flag & 4, 4)
        const info = server.protocol.decode(target.rsp, frame.payload)
        assert.deepEqual(info, value)
        const consumer = new TimelineConsumer(value.uuid)
        consumer.receive(info)
        assert(consumer.start())
        assert.deepEqual(consumer.pose, { x: -9.15, y: 27.32, z: -68.92 })
        for (const client of [owner.client, other.client])
            assert(!client.queue.some((entry) => [11122, 11123].includes(entry.id)))
        for (let index = 0; index < entries.length; index++)
            assert.deepEqual(server.store.load(entries[index].id), before[index])
    } finally {
        for (const client of clients) await client.close()
        if (server) await server.close()
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lurukaps-timeline-'))
        for (const name of fs.readdirSync(directory)) {
            assert(
                [
                    'network.sqlite',
                    'network.sqlite-journal',
                    'network.sqlite-wal',
                    'network.sqlite-shm',
                    'diagnostics.jsonl',
                ].includes(name),
            )
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
})
