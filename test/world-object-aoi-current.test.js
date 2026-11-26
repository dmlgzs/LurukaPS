import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { ErrorCode } from '../src/error-codes.js'
import {
    resetWorldObjectAoiSession,
    createWorldObjectAoi,
    deleteWorldObjectAoi,
    dynamicWorldObjectSnapshot,
    worldItemServerSpawner,
    worldObjectAoiLeaseState,
} from '../src/world-object-aoi.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const guid = (kind, object, index = 0) => ((BigInt(kind) << 56n) | (BigInt(index) << 32n) | BigInt(object)).toString()
const wolf = [guid(4, 10600101), guid(4, 10600101, 1)]
const logged = [guid(3, 4500037), guid(3, 4500075, 1)]
const fingerprint = (value) =>
    createHash('sha256')
        .update(JSON.stringify(value) ?? '<undefined>')
        .digest('hex')
function baseline(id, name, firstBattle = false) {
    const state = seedPlayer(tables, id, name)
    state.tasks = []
    Object.assign(state.world, tables.position(tables.find('world_borthpos', firstBattle ? 10201 : 10001)))
    if (firstBattle) {
        // Qualified pre-battle checkpoint only. No wolf HP, kills, objective
        // witnesses or target completion is seeded; Before is a real request.
        const graph = new TaskGraphs(tables).get(106001),
            finished = new Set()
        const visit = (node) => {
            if (node === graph.start) return
            for (const prev of graph.nodes.get(node).prevNodeIdList ?? []) {
                assert(graph.nodes.has(prev))
                if (finished.has(prev)) continue
                finished.add(prev)
                visit(prev)
            }
        }
        visit(5)
        state.tasks = [
            {
                task_id: 106001,
                nodes: [makeNode(graph, 5, state)],
                finish_nodes: [...finished],
                reward_nodes: [],
                client_trace: true,
            },
        ]
    } else {
        // Coherent independent post-tutorial qualification for normal map100;
        // derive only the prerequisite closure, never mark all tasks complete.
        const completed = new Set(),
            levels = []
        const visit = (taskId) => {
            if (completed.has(taskId)) return
            completed.add(taskId)
            const row = tables.find('task', taskId)
            assert(row)
            for (const part of String(row.unlockcondition).split('|')) {
                const [kind, target] = part.split('#').map(Number)
                if (kind === 2007) visit(target)
                if (kind === 2004) levels.push(target)
            }
        }
        visit(106010)
        state.taskRecords = [...completed].map((task_id) => ({ task_id, count: 1, time: 1 }))
        state.player.basic_info.lv = Math.max(state.player.basic_info.lv, ...levels)
    }
    return state
}
function scope(firstBattle = false) {
    const state = baseline(1, 'aoi-scope', firstBattle),
        pushes = []
    resetWorldObjectAoiSession(state, 'scope-connection-one')
    return {
        state,
        tables,
        now: 1800000000,
        combatSessionId: 'scope-connection-one',
        pushes,
        push: (name, value) => pushes.push({ name, value }),
    }
}
const encodePushes = (c, response) => [
    { id: 11234, payload: protocol.encode(protocol.byId.get(11234).rsp, response) },
    ...c.pushes.map(({ name, value }) => {
        const entry = protocol.byName.get(name)
        return { id: entry.id, payload: protocol.encode(entry.rsp, value) }
    }),
]

// Direct-IL consumers:0600800d ACK remains pending;060287f5 applies cache before
// MapService binding;0600878f releases the enemy waiter.6/26 bind registered
// WorldItem owners by the full entityGuid (06028803/06028802), not a bag ID.
// Assertions on no-heal/packet order are server integrity checks, not a claim
// that this JavaScript model executes Unity or every Native module.
class Consumer {
    constructor(ids) {
        this.pending = new Set(ids)
        this.acks = new Map()
        this.cache = new Map()
        this.records = new Map()
        this.ready = new Map()
        this.controls = new Set()
        this.events = []
    }
    consume(packets) {
        for (const packet of packets) {
            const entry = protocol.byId.get(packet.id),
                value = protocol.decode(entry.rsp, packet.payload)
            this.events.push(packet.id)
            // Current WorldMapSync49/256 creates the destination SceneProxy;
            // its new EntityService does not inherit the old world's cache.
            if (entry.name === 'CSProtoWorldMapSync' && [49, 256].includes(value.cmd)) {
                this.cache.clear()
                this.records.clear()
                this.ready.clear()
                this.controls.clear()
                this.acks.clear()
            }
            if (packet.id === 11234)
                for (const row of value.objs) {
                    assert(this.pending.has(row.guid))
                    assert.notEqual(row.agent_uid, '0')
                    this.acks.set(row.guid, row.agent_uid)
                    // An ACK by itself does not create a Native record/ready actor.
                }
            if (entry.name === 'CSProtoObjBattleInfoSync') for (const row of value.infos) this.cache.set(row.uuid, row)
            if (entry.name === 'SCProtoObjAppearNtf') {
                const obj = value.obj,
                    data = obj.obj_data[0].cli_battle_data,
                    id = data.unit_id,
                    kind = Number(BigInt(id) >> 56n)
                assert.equal(obj.obj_type, kind)
                assert.equal(this.acks.get(id), value.agent_uid)
                if ([3, 4, 7].includes(kind)) {
                    assert.equal(obj.obj_id, Number(BigInt(id) & 0xffffffffn))
                    const life = this.cache.get(id)
                    assert(life, 'life cache must exist before the appear waiter is released')
                    assert.equal(data.fobj_base_data.hp, life.hp)
                    this.ready.set(id, { hp: life.hp, alive: life.alive_state })
                } else {
                    assert.equal(value.agent_type, 8)
                    // Populate's agent8 fallback retains entityGuid even when
                    // the playable has no unrelated static world-map anchor.
                    assert([6, 26].includes(kind))
                    this.ready.set(id, { item: true })
                }
                this.records.set(value.agent_uid, id)
            }
            if (entry.name === 'SCProtoControlChangeByAddNtf') {
                assert(this.records.has(value.agent_uid))
                assert.equal(this.records.get(value.agent_uid), value.cli_data.uuid)
                this.controls.add(value.agent_uid)
            }
            if (entry.name === 'SCProtoControlChangeByDelNtf') this.controls.delete(value.agent_uid)
            if (entry.name === 'SCProtoObjDisappearNtf') {
                const id = this.records.get(value.agent_uid)
                this.records.delete(value.agent_uid)
                this.ready.delete(id)
            }
        }
    }
}

test('scope: logged world GUIDs and full current WorldItem factory/playable catalogs have real declared identities', () => {
    const c = scope()
    assert.equal(c.state.world.map_id, 100)
    for (const id of logged) assert(enemyDefinition(tables, c.state, id)?.max_hp > 0)
    const spawners = tables.get('world_spawner'),
        children = tables.get('playable_object')
    assert.equal(children.length, 720)
    assert.equal(children.filter((row) => worldItemServerSpawner(tables, row.spawnerId)).length, 146)
    assert(spawners.some((row) => row.objectType === 601 && worldItemServerSpawner(tables, row.id)))
    assert(spawners.filter((row) => row.objectType === 50).every((row) => !worldItemServerSpawner(tables, row.id)))
    const first = scope(true)
    for (const id of wolf) {
        const definition = enemyDefinition(tables, first.state, id)
        assert.equal(definition.pack_id, 310624)
        assert.equal(definition.activation_source.task_id, 106001)
    }
})
test('scope: ACK is not ready; current HP cache then Appear/control binds exact world and task member GUIDs', () => {
    for (const firstBattle of [false, true]) {
        const c = scope(firstBattle),
            ids = firstBattle ? wolf : logged,
            response = createWorldObjectAoi(c, { objs: ids }),
            packets = encodePushes(c, response),
            consumer = new Consumer(ids)
        assert.deepEqual(
            response.objs.map((row) => row.guid),
            ids,
        )
        assert(response.objs.every((row) => row.agent_uid === row.guid && row.is_new))
        consumer.consume(packets.slice(0, 1))
        assert.equal(consumer.ready.size, 0)
        consumer.consume(packets.slice(1))
        assert.equal(consumer.ready.size, ids.length)
        assert.equal(consumer.controls.size, ids.length)
    }
})
test('scope: deleting only presence retains accepted HP/death and group generations; duplicate create never heals', () => {
    const c = scope(),
        id = logged[0]
    createWorldObjectAoi(c, { objs: [id] })
    const battle = c.state.combat,
        generation = battle.enemyActivations[id].generation
    const definition = enemyDefinition(tables, c.state, id)
    // A controlled accepted-state vector; actual damage is tested below.
    battle.entities[id] = { uuid: id, ...definition, hp: definition.max_hp - 7, sp: 0, alive_state: 0 }
    const partial = battle.entities[id].hp
    deleteWorldObjectAoi(c, { u64s: [id] })
    assert.equal(battle.entities[id].hp, partial)
    c.pushes.length = 0
    const response = createWorldObjectAoi(c, { objs: [id] })
    assert.equal(battle.entities[id].hp, partial)
    assert.equal(battle.enemyActivations[id].generation, generation)
    assert.equal(response.objs[0].is_new, false)
    c.pushes.length = 0
    assert.equal(createWorldObjectAoi(c, { objs: [id] }).objs[0].is_new, false)
    battle.entities[id].hp = 0
    battle.entities[id].alive_state = 1
    deleteWorldObjectAoi(c, { u64s: [id] })
    c.pushes.length = 0
    const dead = createWorldObjectAoi(c, { objs: [id] }),
        consumer = new Consumer([id])
    consumer.consume(encodePushes(c, dead))
    assert.deepEqual(consumer.ready.get(id), { hp: 0, alive: 1 })
    assert.equal(consumer.controls.size, 0)
    assert.equal(battle.enemyActivations[id].generation, generation)
})
test('scope: WorldItem26 and admitted Playable6 bind owners without creating pets, rewards or unrelated static objects', () => {
    const c = scope(),
        item = guid(26, 100002),
        child = guid(6, 10039, 23)
    assert.throws(() => createWorldObjectAoi(c, { objs: [child] }), { code: ErrorCode.InvalidTarget })
    c.state.playableRuns = { 10039: { play_id: 10039, map_id: 100, status: 1, time: c.now, finish_step: 0 } }
    const assets = fingerprint(c.state.player),
        pets = fingerprint(c.state.pets)
    const response = createWorldObjectAoi(c, { objs: [item, child] }),
        consumer = new Consumer([item, child])
    consumer.consume(encodePushes(c, response))
    assert.equal(consumer.ready.size, 2)
    assert.equal(c.pushes.filter((packet) => packet.name === 'CSProtoObjBattleInfoSync').length, 0)
    assert.equal(c.pushes.find((packet) => packet.value.obj?.obj_type === 6).value.obj.obj_id, 0)
    assert.equal(fingerprint(c.state.player), assets)
    assert.equal(fingerprint(c.state.pets), pets)
    assert.equal(c.state.worldObjects, undefined)
    assert.throws(() => createWorldObjectAoi(c, { objs: [guid(26, 4500037)] }), { code: ErrorCode.InvalidTarget })
    assert.throws(() => createWorldObjectAoi(c, { objs: [guid(6, 10039, 24), guid(6, 10039, 999)] }), {
        code: ErrorCode.InvalidTarget,
    })
})
test('scope: remote9199 snapshot uses saved dynamic fields, includes inactive records, excludes private claims and other maps', () => {
    const c = scope(),
        raw = {
            obj_id: 1900000001,
            active: true,
            complete: false,
            pos: { x: 100, y: 200, z: 300 },
            expand_data: { dynamic_obj: { spawner_id: 99010, expand_id: 5148, source_type: 0 } },
            claims: { private: 'not-wire' },
        }
    c.state.worldObjects = {
        '100:1900000001': raw,
        '102:1900000001': structuredClone(raw),
        '100:4500037': { obj_id: 4500037, active: true },
    }
    const before = fingerprint(c.state)
    const value = dynamicWorldObjectSnapshot(tables, c.state, 100)
    assert.equal(value.objs.length, 1)
    assert.equal(value.objs[0].claims, undefined)
    assert.deepEqual(value.objs[0].expand_data, raw.expand_data)
    assert.equal(fingerprint(c.state), before)
    protocol.encode(protocol.byName.get('SCProtoDynamicObjInfosSync').rsp, value)
    raw.active = false
    assert.equal(dynamicWorldObjectSnapshot(tables, c.state, 100).objs[0].active, false)
    assert.equal(dynamicWorldObjectSnapshot(tables, c.state, 101).objs.length, 0)
    assert.throws(() => dynamicWorldObjectSnapshot(tables, c.state, 99999999), { code: ErrorCode.InvalidTarget })
})
test('scope: connection reset and scene runtime expiry affect leases only; stale/invalid identities stay strict', () => {
    const c = scope(),
        id = logged[0]
    createWorldObjectAoi(c, { objs: [id] })
    const combat = fingerprint(c.state.combat)
    resetWorldObjectAoiSession(c.state, 'scope-connection-two')
    assert.equal(fingerprint(c.state.combat), combat)
    assert.throws(() => deleteWorldObjectAoi(c, { u64s: [id] }), { code: ErrorCode.InvalidTarget })
    c.combatSessionId = 'scope-connection-two'
    assert.equal(createWorldObjectAoi(c, { objs: [id] }).objs[0].is_new, false)
    for (const value of ['0', '-1', '1.5', '18446744073709551616', 9007199254740992])
        assert.throws(() => createWorldObjectAoi(c, { objs: [value] }), { code: ErrorCode.InvalidArgument })
    assert.throws(() => createWorldObjectAoi(c, { objs: [id, id] }), { code: ErrorCode.InvalidArgument })
    assert.throws(() => createWorldObjectAoi(c, { objs: [guid(2, 1)] }), { code: ErrorCode.InvalidTarget })
    assert.throws(() => createWorldObjectAoi(c, { objs: [guid(3, 4500075, 99)] }), { code: ErrorCode.InvalidTarget })
})

function fixture(name, firstBattle = false) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let nowMs = 1800000000000,
        sequence = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => Math.floor(nowMs / 1000) })
    const account = store.login(name, (id, openId) => baseline(id, openId, firstBattle))
    const call = (name, value = {}, target = session) => {
        const row = protocol.byName.get(name) ?? protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: row.id,
            seq: sequence++,
            payload: row.req ? protocol.encode(row.req, value) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(account.id).state
    return {
        protocol,
        store,
        game,
        call,
        state,
        account,
        get session() {
            return session
        },
        login: () => call('EnterGame', { open_id: name }),
        reload: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        edit: (fn) => store.transact(account.id, 0, fn),
        other: (otherName) => {
            const peer = store.login(otherName, (id, openId) => baseline(id, openId))
            const target = {}
            call('EnterGame', { open_id: otherName }, target)
            return {
                call: (name, value) => call(name, value, target),
                state: () => store.load(peer.id).state,
                session: target,
            }
        },
        savedHash: () =>
            fingerprint(store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(account.id)),
        hurt: (target, hp) =>
            call('BattleInfoReduce', {
                base_time: String(++nowMs),
                uint64_dic: [state().player.heros_info.heros.find((row) => row.type === 1 && !row.trail).guid, target],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hp } }],
            }),
    }
}

test('Game: current first106001 wolf checkpoint receives matching11234 records, reaches Native ready, and real damage survives AOI release/reentry', () => {
    const f = fixture('current-aoi-first-wolves', true)
    try {
        f.login()
        f.call('TaskClientBefore', { task_id: 106001, node_id: 5 })
        assert.equal(f.state().world.map_id, 102)
        const node = f
            .state()
            .tasks.find((row) => row.task_id === 106001)
            .nodes.find((row) => row.node_id === 5)
        assert.equal(node.client_before, true)
        const consumer = new Consumer(wolf),
            out = f.call('TryCreateWorldObj', { objs: wolf })
        consumer.consume(out)
        assert.equal(consumer.ready.size, 2)
        const hp = enemyDefinition(tables, f.state(), wolf[0]).max_hp
        f.hurt(wolf[0], 1)
        assert.equal(f.state().combat.entities[wolf[0]].hp, hp - 1)
        const assets = fingerprint(f.state().player.sbag_infos),
            raw = fingerprint(f.state().worldObjects),
            generation = f.state().combat.enemyActivations[guid(4, 10600101)].generation
        consumer.consume(f.call('TryDeleteWorldObj', { u64s: [wolf[0]] }))
        assert.equal(consumer.ready.has(wolf[0]), false)
        consumer.consume(f.call('TryCreateWorldObj', { objs: [wolf[0]] }))
        assert.equal(consumer.ready.get(wolf[0]).hp, hp - 1)
        assert.equal(f.state().combat.enemyActivations[guid(4, 10600101)].generation, generation)
        assert.equal(fingerprint(f.state().player.sbag_infos), assets)
        assert.equal(fingerprint(f.state().worldObjects), raw)
        f.reload()
        const cold = new Consumer(wolf)
        cold.consume(f.call('TryCreateWorldObj', { objs: wolf }))
        assert.equal(cold.ready.get(wolf[0]).hp, hp - 1)
    } finally {
        f.store.close()
    }
})

test('scope: readonly lease query admits an unhurt actor without a HP cache and rejects released/stale contexts without writes', () => {
    const c = scope(),
        id = logged[0]
    const before = fingerprint(c.state)
    assert.deepEqual(worldObjectAoiLeaseState(c.state, id, c.combatSessionId), { known: false, active: false })
    assert.equal(fingerprint(c.state), before)
    createWorldObjectAoi(c, { objs: [id] })
    assert.equal(c.state.combat.entities[id], undefined)
    const current = fingerprint(c.state)
    assert.deepEqual(worldObjectAoiLeaseState(c.state, id, c.combatSessionId), { known: true, active: true })
    assert.deepEqual(worldObjectAoiLeaseState(c.state, id, 'other-connection'), { known: true, active: false })
    assert.equal(fingerprint(c.state), current)
    deleteWorldObjectAoi(c, { u64s: [id] })
    assert.deepEqual(worldObjectAoiLeaseState(c.state, id, c.combatSessionId), { known: true, active: false })
    resetWorldObjectAoiSession(c.state, 'scope-connection-two')
    assert.equal(
        createWorldObjectAoi({ ...c, combatSessionId: 'scope-connection-two' }, { objs: [id] }).objs[0].is_new,
        false,
    )
})

test('scope: over512 unhurt admissions never evict accepted partial HP or create mutation-cache entries', () => {
    const c = scope(),
        protectedId = logged[0]
    createWorldObjectAoi(c, { objs: [protectedId] })
    const definition = enemyDefinition(tables, c.state, protectedId)
    c.state.combat.entities[protectedId] = {
        uuid: protectedId,
        ...definition,
        hp: definition.max_hp - 1,
        sp: 3,
        alive_state: 0,
    }
    const candidates = []
    for (const row of tables.get('worldmap_100')) {
        if (
            row.initStatus ||
            row.initialCompleteState ||
            row.appearCond ||
            row.disappearCond ||
            tables.find('world_spawner', row.spawnerId)?.objectType !== 50
        )
            continue
        const first = enemyDefinition(tables, c.state, guid(3, row.id))
        if (!first) continue
        for (let index = 0; index < first.group_size; index++) {
            const id = guid(3, row.id, index)
            if (id !== protectedId && enemyDefinition(tables, c.state, id)) candidates.push(id)
            if (candidates.length === 600) break
        }
        if (candidates.length === 600) break
    }
    assert(candidates.length > 512)
    c.pushes.length = 0
    const result = createWorldObjectAoi(c, { objs: candidates })
    assert.equal(result.objs.length, candidates.length)
    assert.equal(Object.keys(c.state.combat.entities).length, 1)
    assert.equal(c.state.combat.entities[protectedId].hp, definition.max_hp - 1)
    assert.equal(c.state.combat.entities[protectedId].sp, 3)
    assert.deepEqual(worldObjectAoiLeaseState(c.state, candidates[0], c.combatSessionId), { known: true, active: true })
})

test('Game: actual public PlayableStart and world-item requests bind26/6;9199 pushes typed saved remote data and invokes its cache callback', () => {
    const f = fixture('current-aoi-world-items')
    try {
        f.login()
        assert.equal(f.state().world.map_id, 100)
        const item = guid(26, 100002),
            child = guid(6, 10039, 23)
        const consumer = new Consumer([item, child])
        const before = fingerprint(f.state())
        assert.throws(() => f.call('TryCreateWorldObj', { objs: [child] }), { code: ErrorCode.InvalidTarget })
        assert.equal(fingerprint(f.state()), before)
        f.call('PlayableStart', { u32: 10039 })
        assert.equal(f.state().playableRuns[10039].map_id, 100)
        assert.equal(f.state().playableRuns[10039].status, 1)
        const assets = fingerprint(f.state().player.sbag_infos),
            pets = fingerprint(f.state().pets)
        consumer.consume(f.call('TryCreateWorldObj', { objs: [item, child] }))
        assert.equal(consumer.ready.size, 2)
        assert.equal(fingerprint(f.state().player.sbag_infos), assets)
        assert.equal(fingerprint(f.state().pets), pets)
        const selected = {
            obj_id: 1900000001,
            active: true,
            complete: false,
            pos: { x: 100, y: 200, z: 300 },
            expand_data: { dynamic_obj: { spawner_id: 753014, expand_id: 0 } },
            claims: { private: 1 },
        }
        f.edit((s) => {
            ;(s.worldObjects ??= {})['102:1900000001'] = structuredClone(selected)
        })
        const remote = new Map(),
            pending = new Set([102]),
            stateBefore = fingerprint(f.state()),
            combatBefore = fingerprint(f.state().combat)
        const receive = (packets) => {
            for (const packet of packets)
                if (packet.id === 9200) {
                    const value = f.protocol.decode(f.protocol.byId.get(9200).rsp, packet.payload)
                    if (!remote.has(value.map_id)) remote.set(value.map_id, new Map())
                    for (const obj of value.objs ?? []) remote.get(value.map_id).set(obj.obj_id, obj)
                    pending.delete(value.map_id)
                }
        }
        const out = f.call('SCProtoDynamicObjInfosReq', { u32: 102 })
        assert(out.some((row) => row.id === 9199))
        receive(out)
        assert.equal(pending.has(102), false)
        assert.deepEqual(remote.get(102).get(selected.obj_id).expand_data, selected.expand_data)
        assert.equal(remote.get(102).get(selected.obj_id).claims, undefined)
        assert.equal(f.state().world.map_id, 100)
        assert.equal(fingerprint(f.state().combat), combatBefore)
        assert.equal(fingerprint(f.state()), stateBefore)
        f.edit((s) => {
            s.worldObjects['102:1900000001'].active = false
        })
        receive(f.call('SCProtoDynamicObjInfosReq', { u32: 102 }))
        assert.equal(
            remote.get(102).get(selected.obj_id).active,
            false,
            'Native merges remote snapshots; explicit inactive records must remain',
        )
        f.call('PlayableCancel', { playId: 10039 })
        consumer.consume(f.call('TryDeleteWorldObj', { u64s: [child, item] }))
        assert.equal(consumer.ready.size, 0)
    } finally {
        f.store.close()
    }
})

test('Game: two accounts keep independent presence and accepted HP; cold reconnect retains logical receipt without restarting another account', () => {
    const f = fixture('current-aoi-owner-one')
    try {
        f.login()
        const peer = f.other('current-aoi-owner-two'),
            id = logged[0]
        const a = new Consumer([id]),
            b = new Consumer([id])
        a.consume(f.call('TryCreateWorldObj', { objs: [id] }))
        b.consume(peer.call('TryCreateWorldObj', { objs: [id] }))
        const hp = a.ready.get(id).hp,
            peerBefore = fingerprint(peer.state())
        f.hurt(id, 1)
        a.consume(f.call('TryDeleteWorldObj', { u64s: [id] }))
        const resumed = f.call('TryCreateWorldObj', { objs: [id] })
        a.consume(resumed)
        assert.equal(a.ready.get(id).hp, hp - 1)
        assert.equal(fingerprint(peer.state()), peerBefore)
        assert.equal(b.ready.get(id).hp, hp)
        assert(resumed.every((packet) => !packet.audience && (!packet.recipient || packet.recipient === f.account.id)))
        f.reload()
        const cold = new Consumer([id]),
            packets = f.call('TryCreateWorldObj', { objs: [id] })
        cold.consume(packets)
        assert.equal(cold.ready.get(id).hp, hp - 1)
        assert.equal(
            f.protocol.decode(f.protocol.byId.get(11234).rsp, packets.find((packet) => packet.id === 11234).payload)
                .objs[0].is_new,
            false,
        )
        assert.equal(fingerprint(peer.state()), peerBefore)
    } finally {
        f.store.close()
    }
})

test('Game: create/delete codec and SQL failures roll back leases, activation, accepted HP, player assets and saved SQL; retries work', () => {
    for (const operation of ['create', 'delete'])
        for (const mode of ['codec', 'sql']) {
            const f = fixture('current-aoi-rollback-' + operation + '-' + mode)
            const encode = f.protocol.encode,
                save = f.store.savePlayer,
                id = logged[0]
            try {
                f.login()
                if (operation === 'delete') {
                    f.call('TryCreateWorldObj', { objs: [id] })
                    f.hurt(id, 1)
                }
                const before = fingerprint(f.state()),
                    sql = f.savedHash()
                if (mode === 'codec') {
                    const target = f.protocol.byName.get(
                        operation === 'create' ? 'SCProtoObjAppearNtf' : 'SCProtoObjDisappearNtf',
                    ).rsp
                    f.protocol.encode = function (name, ...args) {
                        if (name === target) throw Error('aoi-transaction-codec')
                        return encode.call(this, name, ...args)
                    }
                } else
                    f.store.savePlayer = {
                        run() {
                            throw Error('aoi-transaction-sql')
                        },
                    }
                const run = () =>
                    operation === 'create'
                        ? f.call('TryCreateWorldObj', { objs: [id] })
                        : f.call('TryDeleteWorldObj', { u64s: [id] })
                assert.throws(run, new RegExp('aoi-transaction-' + mode))
                assert.equal(fingerprint(f.state()), before)
                assert.equal(f.savedHash(), sql)
                f.protocol.encode = encode
                f.store.savePlayer = save
                run()
                assert.equal(worldObjectAoiLeaseState(f.state(), id, f.session.token).active, operation === 'create')
            } finally {
                f.protocol.encode = encode
                f.store.savePlayer = save
                f.store.close()
            }
        }
})

test('Game: real home exit and return expire old scene leases; a legitimate new runtime reinitializes the same configured world actor', () => {
    const f = fixture('current-aoi-scene-scope'),
        id = logged[0]
    try {
        f.login()
        const consumer = new Consumer([id])
        consumer.consume(f.call('TryCreateWorldObj', { objs: [id] }))
        const epoch = f.state().combat.runtimeEpoch
        assert.equal(worldObjectAoiLeaseState(f.state(), id, f.session.token).active, true)
        consumer.consume(f.call('EnterHome'))
        assert.notEqual(f.state().world.map_id, 100)
        assert.equal(consumer.cache.has(id), false)
        assert.equal(worldObjectAoiLeaseState(f.state(), id, f.session.token).active, false)
        const returned = f.call('WorldQuitHome')
        consumer.consume(returned)
        assert.equal(f.state().world.map_id, 100)
        assert(consumer.cache.has(id), 'actual optimized return stream must restore HP after its scene packet')
        assert.equal(consumer.ready.has(id), false, 'a life cache alone cannot release the AOI pending waiter')
        const out = f.call('TryCreateWorldObj', { objs: [id] })
        consumer.consume(out)
        assert(f.state().combat.runtimeEpoch > epoch)
        assert.equal(consumer.ready.get(id).hp, enemyDefinition(tables, f.state(), id).max_hp)
        assert.equal(
            f.protocol.decode(f.protocol.byId.get(11234).rsp, out.find((packet) => packet.id === 11234).payload).objs[0]
                .is_new,
            true,
        )
    } finally {
        f.store.close()
    }
})
