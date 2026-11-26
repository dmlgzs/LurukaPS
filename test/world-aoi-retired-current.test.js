import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { worldCondition } from '../src/handlers/world-objects.js'
import { worldSearchVisible } from '../src/world-search-visible.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    graph = new TaskGraphs(tables).get(106010)
const guid = (object, slot = 0) => ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(object)).toString()
const retired = [guid(201073), guid(201073, 2), guid(201073, 1)],
    active = guid(4500037)
assert.deepEqual(retired, ['216172782113984881', '216172790703919473', '216172786408952177'])

function fixture(name, { node = 177, finished = [184, 185], view = tables, hidden = false } = {}) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, view, { clock: () => 1800000000 })
    let sequence = 1
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        assert(e, name)
        return game.dispatch(session, {
            id: e.id,
            seq: sequence++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: 'retired-aoi-' + name })
    store.transact(session.id, 0, (state) => {
        // Independent trusted phase checkpoint: current106010/177 and finished
        //184/185 were observed before the live player moved on. No source DB
        //is read; this does not replay the preceding story or seed HP/kills.
        Object.assign(state.world, view.position(view.find('world_borthpos', 10050)))
        const completed = new Set(),
            levels = []
        const visit = (id) => {
            const row = view.find('task', id)
            assert(row)
            for (const part of String(row.unlockcondition).split('|').filter(Boolean)) {
                const [kind, target] = part.split('#').map(Number)
                if (kind === 2007 || kind === 12045) {
                    if (!completed.has(target)) {
                        completed.add(target)
                        visit(target)
                    }
                } else if (kind === 2004) levels.push(target)
                else assert.fail('Unsupported checkpoint prerequisite ' + part)
            }
        }
        visit(106010)
        state.taskRecords = [...completed].map((task_id) => ({ task_id, count: 1, time: 1799999999 }))
        state.player.basic_info.lv = Math.max(state.player.basic_info.lv, ...levels)
        state.taskEpochs[106010] = 1
        state.tasks = [
            {
                task_id: 106010,
                nodes: [makeNode(graph, node, state)],
                finish_nodes: [...finished],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        // No old presence/combat is fabricated for a never-admitted queued
        //request. This also proves the drain path cannot allocate those stores.
        delete state.combat
        delete state.worldObjectAoi
        if (hidden) (state.worldObjects ??= {})['100:201073'] = { obj_id: 201073, active: false }
    })
    // Settle the independent checkpoint's ordinary historical observations
    //through a real non-MapSync observer, without pre-admitting the queued
    //actors. Their absence is then the exact boundary measured below.
    call('DayWeatherSync', { weather: store.load(session.id).state.world.weather })
    store.transact(session.id, 0, (state) => {
        delete state.combat
        delete state.worldObjectAoi
        delete state.combatEnemyPresentations
    })
    const state = () => store.load(session.id).state
    const decode = (id, packets) => {
        const packet = packets.find((p) => p.id === id)
        assert(packet, 'missing packet' + id)
        return protocol.decode(protocol.byId.get(id).rsp, packet.payload)
    }
    return { store, session, protocol, call, state, decode, edit: (fn) => store.transact(session.id, 0, fn) }
}
function protection(state) {
    const { combat, worldObjectAoi, nextCombatRuntimeEpoch, combatEnemyPresentations, ...rest } = state
    return structuredClone(rest)
}
function retiredPhase(f) {
    const row = tables.find('worldmap_100', 201073),
        s = f.state()
    assert.equal(s.world.map_id, 100)
    assert.equal(s.tasks[0].task_id, 106010)
    assert.equal(s.tasks[0].nodes[0].node_id, 177)
    assert(graph.nodes.has(177) && graph.nodes.has(184) && graph.nodes.has(185))
    assert.equal(worldCondition(row.appearCond, s), true)
    assert.equal(worldCondition(row.disappearCond, s), true)
    assert.equal(worldSearchVisible(row, s.worldObjects?.['100:201073'], s), false)
}
function onlyBirths(f, packets, ids) {
    const allowed = new Set(ids),
        ack = f.decode(11234, packets)
    assert.deepEqual(
        ack.objs.map((row) => row.guid),
        ids,
    )
    const life = packets
        .filter((p) => p.id === 10009)
        .flatMap((p) => f.protocol.decode(f.protocol.byId.get(10009).rsp, p.payload).infos)
    assert.deepEqual(new Set(life.map((row) => row.uuid)), allowed)
    for (const id of ids) {
        const row = life.find((row) => row.uuid === id),
            definition = enemyDefinition(tables, f.state(), id)
        assert.equal(row.hp, definition.max_hp)
        assert.equal(row.alive_state, 0)
        const appears = packets
                .filter((p) => p.id === 11063)
                .map((p) => f.protocol.decode(f.protocol.byId.get(11063).rsp, p.payload)),
            controls = packets
                .filter((p) => p.id === 11067)
                .map((p) => f.protocol.decode(f.protocol.byId.get(11067).rsp, p.payload))
        assert.deepEqual(new Set(appears.map((r) => r.agent_uid)), allowed)
        assert.deepEqual(new Set(controls.map((r) => r.agent_uid)), allowed)
        const hpIndex = packets.findIndex(
                (p) =>
                    p.id === 10009 &&
                    f.protocol.decode(f.protocol.byId.get(10009).rsp, p.payload).infos.some((r) => r.uuid === id),
            ),
            appearIndex = packets.findIndex(
                (p) => p.id === 11063 && f.protocol.decode(f.protocol.byId.get(11063).rsp, p.payload).agent_uid === id,
            ),
            controlIndex = packets.findIndex(
                (p) => p.id === 11067 && f.protocol.decode(f.protocol.byId.get(11067).rsp, p.payload).agent_uid === id,
            )
        assert(
            packets.findIndex((p) => p.id === 11234) < hpIndex && hpIndex < appearIndex && appearIndex < controlIndex,
        )
    }
}

test('actual expired106010/177 stage drains three201073 requests with empty ACK and zero combat/lease/goal/asset mutations', () => {
    const f = fixture('expired')
    try {
        retiredPhase(f)
        const before = structuredClone(f.state())
        for (let attempt = 0; attempt < 2; attempt++) {
            const packets = f.call('TryCreateWorldObj', { objs: retired })
            assert.deepEqual(f.decode(11234, packets).objs, [])
            assert(!packets.some((p) => [10009, 11063, 11067, 11064].includes(p.id)))
            assert.deepEqual(f.state(), before)
            assert.equal(f.state().combat, undefined)
            assert.equal(f.state().worldObjectAoi, undefined)
        }
    } finally {
        f.store.close()
    }
})

test('mixed expired201073 and declared visible actor emit only the active birth and never register retired identities', () => {
    const f = fixture('mixed')
    try {
        retiredPhase(f)
        assert(worldSearchVisible(tables.find('worldmap_100', 4500037), undefined, f.state()))
        assert(enemyDefinition(tables, f.state(), active))
        const before = protection(f.state()),
            packets = f.call('TryCreateWorldObj', { objs: [retired[0], active, retired[1], retired[2]] })
        onlyBirths(f, packets, [active])
        assert.deepEqual(protection(f.state()), before)
        assert.deepEqual(Object.keys(f.state().worldObjectAoi.agents), [active])
        assert.deepEqual(Object.keys(f.state().combatEnemyPresentations[100]), [active])
        for (const id of retired) {
            assert.equal(f.state().worldObjectAoi.agents[id], undefined)
            assert.equal(f.state().combat.entities[id], undefined)
        }
        assert.equal(f.state().combat.enemyActivations[retired[0]], undefined)
    } finally {
        f.store.close()
    }
})

test('bad retired slot, unknown identity and broken configuration still fail atomically instead of being swallowed', () => {
    const broken = new Tables(cfg.tables)
    broken.cache.set(
        'worldmap_100',
        tables.get('worldmap_100').map((row) => (row.id === 201073 ? { ...row, spawnerId: 9999999 } : row)),
    )
    for (const [name, view, ids, code] of [
        ['slot3', tables, [retired[0], guid(201073, 3)], ErrorCode.InvalidTarget],
        ['unknown', tables, [guid(9999999)], ErrorCode.InvalidArgument],
        ['bad-config', broken, retired, ErrorCode.SpawnerConfIsNull],
    ]) {
        const f = fixture(name, { view })
        try {
            const before = structuredClone(f.state())
            assert.throws(() => f.call('TryCreateWorldObj', { objs: ids }), { code })
            assert.deepEqual(f.state(), before)
        } finally {
            f.store.close()
        }
    }
})

test('not-yet-appeared and a saved hidden source before disappearance are not mistaken for retired phases', () => {
    for (const [name, options, appeared] of [
        ['before-appear', { node: 184, finished: [] }, false],
        ['hidden-before-disappear', { node: 185, finished: [184], hidden: true }, true],
    ]) {
        const f = fixture(name, options)
        try {
            const row = tables.find('worldmap_100', 201073),
                before = structuredClone(f.state())
            assert.equal(worldCondition(row.appearCond, before), appeared)
            assert.equal(worldCondition(row.disappearCond, before), false)
            assert.equal(worldSearchVisible(row, before.worldObjects?.['100:201073'], before), false)
            assert.throws(() => f.call('TryCreateWorldObj', { objs: retired }), { code: ErrorCode.InvalidTarget })
            assert.deepEqual(f.state(), before)
        } finally {
            f.store.close()
        }
    }
})

test('a separate new-attempt pre185 checkpoint can create the same three GUIDs after a declined old phase', () => {
    const f = fixture('new-attempt')
    try {
        retiredPhase(f)
        assert.deepEqual(f.decode(11234, f.call('TryCreateWorldObj', { objs: retired })).objs, [])
        f.edit((state) => {
            state.taskEpochs[106010] = 2
            state.tasks = [
                {
                    task_id: 106010,
                    nodes: [makeNode(graph, 185, state)],
                    finish_nodes: [184],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        f.call('DayWeatherSync', { weather: f.state().world.weather })
        const row = tables.find('worldmap_100', 201073),
            before = protection(f.state())
        assert.equal(worldCondition(row.appearCond, f.state()), true)
        assert.equal(worldCondition(row.disappearCond, f.state()), false)
        assert(worldSearchVisible(row, undefined, f.state()))
        const packets = f.call('TryCreateWorldObj', { objs: retired })
        onlyBirths(f, packets, retired)
        assert.deepEqual(protection(f.state()), before)
        assert.deepEqual(Object.keys(f.state().worldObjectAoi.agents), retired)
        assert.deepEqual(new Set(Object.keys(f.state().combatEnemyPresentations[100])), new Set(retired))
        assert(f.state().combat.enemyActivations[retired[0]].active)
    } finally {
        f.store.close()
    }
})
