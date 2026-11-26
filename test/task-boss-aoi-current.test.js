import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { activeFormationManager } from '../src/trial-actors.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { createWorldObjectAoi, deleteWorldObjectAoi } from '../src/world-object-aoi.js'
import { activeTaskWorldBattleSource } from '../src/task-world-battle-source.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    graph = new TaskGraphs(tables).get(106002),
    boss = ((3n << 56n) | 600003n).toString(),
    old = [
        ((3n << 56n) | (1n << 32n) | 200005n).toString(),
        ((3n << 56n) | 200003n).toString(),
        ((3n << 56n) | (1n << 32n) | 200003n).toString(),
    ],
    finished = [1, 56, 65, 61, 58, 63, 62, 57]

function fixture(name) {
    const store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let sequence = 1,
        reportMs = 1800000000000
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, name)
        return game.dispatch(session, {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: 'task-boss-aoi-' + name })
    store.transact(session.id, 0, (state) => {
        // Trusted exact pre-node59 checkpoint, not a seeded boss kill or a
        // scene104 activation. Transfer/Before/trial control are real requests.
        Object.assign(state.world, tables.position(tables.find('world_borthpos', 10201)))
        state.tasks = [
            {
                task_id: 106002,
                nodes: [makeNode(graph, 59, state)],
                finish_nodes: [...finished],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        state.taskRecords = [{ task_id: 106001, count: 1, time: 1799999999 }]
        state.taskEpochs[106002] = 1
    })
    const state = () => store.load(session.id).state,
        decode = (id, packets) => {
            const frame = packets.find((packet) => packet.id === id)
            assert(frame, 'missing packet' + id)
            return protocol.decode(protocol.byId.get(id).rsp, frame.payload)
        },
        hit = (damage) => {
            const manager = activeFormationManager(state()),
                group = manager.groups.find((row) => row.id === manager.cur_group)
            assert(group.control && group.control !== '0')
            const packets = call('BattleInfoReduce', {
                base_time: String(++reportMs),
                uint64_dic: [group.control, boss],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -damage } }],
            })
            return packets
        }
    return { store, session, call, state, decode, hit }
}
function facts(state) {
    return structuredClone({
        tasks: state.tasks,
        taskRecords: state.taskRecords,
        taskItems: state.taskItems,
        worldObjects: state.worldObjects,
        entities: state.combat?.entities,
        terminals: state.combat?.enemyTerminals,
        pets: state.pets,
        bag: state.player.sbag_infos,
        attrs: state.player.attr_infos,
        allocator: state.nextPetSequence,
    })
}
function expectBossBirth(f, packets, expectedHp) {
    const ackIndex = packets.findIndex((packet) => packet.id === 11234),
        hpIndex = packets.findIndex((packet) => packet.id === 10009),
        appearIndex = packets.findIndex((packet) => packet.id === 11063),
        controlIndex = packets.findIndex((packet) => packet.id === 11067)
    assert(ackIndex >= 0 && hpIndex > ackIndex && appearIndex > hpIndex && controlIndex > appearIndex)
    const ack = f.decode(11234, packets),
        life = f.decode(10009, packets).infos.find((row) => row.uuid === boss),
        appearance = f.decode(11063, packets)
    assert.equal(ack.objs[0].guid, boss)
    assert.equal(ack.objs[0].agent_uid, boss)
    assert.equal(life.hp, expectedHp)
    assert.equal(life.alive_state, 0)
    assert.equal(appearance.agent_uid, boss)
    assert.equal(appearance.obj.obj_type, 3)
    assert.equal(appearance.obj.obj_id, 600003)
    assert.equal(appearance.obj.obj_data[0].cli_battle_data.mon_base_data.enemy_pack, 400068)
    assert.equal(appearance.obj.obj_data[0].cli_battle_data.fobj_base_data.hp, life.hp)
    assert.equal(f.decode(11067, packets).agent_uid, boss)
    assert.equal(f.state().worldObjects?.['104:600003'], undefined, 'admission never writes an active-world override')
    assert.equal(f.state().tasks.find((task) => task.task_id === 106002).nodes[0].node_values[0], 0)
}
function cleanup(f, ids = old) {
    const before = facts(f.state()),
        packets = f.call('TryDeleteWorldObj', { u64s: ids })
    assert.deepEqual(
        packets.map((packet) => packet.id),
        [11237],
        'old leases must not send disappear/control into104',
    )
    assert.deepEqual(facts(f.state()), before, 'cleanup changes only presentation receipts')
}

for (const order of ['before-new-create', 'after-new-create'])
    test(`actual106002/59 transfer, old102 cleanup ${order}, boss admission and real damage advance only after HP0`, () => {
        const f = fixture(order)
        try {
            assert.equal(f.state().world.map_id, 102)
            assert.equal(f.state().tasks[0].nodes[0].client_before, false)
            const issued = f.call('TryCreateWorldObj', { objs: old })
            assert.deepEqual(
                f.decode(11234, issued).objs.map((row) => row.guid),
                old,
            )
            assert(old.every((id) => f.state().worldObjectAoi.agents[id].active))
            const trial = graph.controllers.find(
                (controller) =>
                    controller.__type_TaskTeamController?.stateScene?.includes(104) &&
                    controller.overrideNodeIds?.includes(59),
            )?.__type_TaskTeamController
            assert(trial)
            f.call('TrialGroupChange', { open: true, trial_id: trial.trialsId })
            assert.equal(f.state().trialGroup.current_group_id, 2)
            f.call('EnterWorldMap', {
                map_id: 104,
                point_id: 10401,
                task_id: 106002,
                node_id: 59,
                client_trans_data: 2,
            })
            f.call('MultiCampaignPlayerLoaded')
            assert.equal(f.state().world.map_id, 104, 'real2300 pre-action9100 performs the configured transfer')
            assert.equal(
                f.state().tasks[0].nodes[0].client_before,
                false,
                'creation occurs during pre-actions, before9861',
            )
            assert.equal(f.state().worldObjects?.['104:600003'], undefined)
            if (order === 'before-new-create') {
                cleanup(f)
                cleanup(f)
            }
            const definition = enemyDefinition(tables, f.state(), boss)
            assert.equal(definition.pack_id, 400068)
            expectBossBirth(f, f.call('TryCreateWorldObj', { objs: [boss] }), definition.max_hp)
            cleanup(f)
            cleanup(f)
            f.call('TaskClientBefore', { task_id: 106002, node_id: 59 })
            assert.equal(f.state().trialGroup.current_group_id, trial.trialsId)
            assert.equal(activeFormationManager(f.state()).cur_group, 0)
            assert.equal(f.state().tasks[0].nodes[0].client_before, true)
            const damage = Math.min(100, definition.max_hp - 1)
            f.hit(damage)
            assert.equal(f.state().combat.entities[boss].hp, definition.max_hp - damage)
            assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
            cleanup(f)
            expectBossBirth(f, f.call('TryCreateWorldObj', { objs: [boss] }), definition.max_hp - damage)
            f.hit(definition.max_hp - damage)
            assert.equal(f.state().combat.entities[boss].hp, 0)
            assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
            f.call('TaskClientCondAfter', { task_id: 106002, node_id: 59, indexes: [0] })
            f.call('TaskClientAfter', { task_id: 106002, node_id: 59 })
            assert(
                f
                    .state()
                    .tasks.find((task) => task.task_id === 106002)
                    .nodes.some((node) => node.node_id === 64),
            )
        } finally {
            f.store.close()
        }
    })

function scope(state, session, sourceTables = tables) {
    const pushes = []
    return {
        state,
        tables: sourceTables,
        now: 1800000000,
        combatSessionId: session.token,
        pushes,
        push: (name, value) => pushes.push({ name, value }),
    }
}
test('typed pre-action task target cannot bypass inactive/completed/wrong-scene nodes, explicit state or appearance conditions', () => {
    const f = fixture('scope')
    try {
        f.call('EnterWorldMap', { map_id: 104, point_id: 10401, task_id: 106002, node_id: 59, client_trans_data: 2 })
        const baseline = f.state(),
            variants = [
                [
                    'goal-done',
                    (s) => {
                        s.tasks[0].nodes[0].node_values[0] = 1
                    },
                ],
                [
                    'condition-ack',
                    (s) => {
                        s.tasks[0].nodes[0].client_cond_after = [true]
                    },
                ],
                [
                    'finished-node',
                    (s) => {
                        s.tasks[0].finish_nodes.push(59)
                    },
                ],
                [
                    'unmatched',
                    (s) => {
                        s.tasks = []
                    },
                ],
                [
                    'same-id-102-npc',
                    (s) => {
                        s.tasks[0].nodes = [{ ...makeNode(graph, 57, s), client_before: true }]
                        s.tasks[0].finish_nodes = s.tasks[0].finish_nodes.filter((id) => id !== 57)
                    },
                ],
                [
                    'explicit-inactive',
                    (s) => {
                        s.worldObjects ??= {}
                        s.worldObjects['104:600003'] = { obj_id: 600003, active: false }
                    },
                ],
                [
                    'completed-object',
                    (s) => {
                        s.worldObjects ??= {}
                        s.worldObjects['104:600003'] = { obj_id: 600003, complete: true }
                    },
                ],
            ]
        for (const [name, mutate] of variants) {
            const state = structuredClone(baseline)
            mutate(state)
            const c = scope(state, f.session),
                before = structuredClone(state)
            assert.throws(
                () => createWorldObjectAoi(c, { objs: [boss] }),
                (error) => error.code === ErrorCode.InvalidTarget,
                name,
            )
            assert.deepEqual(state, before, name)
            assert.deepEqual(c.pushes, [])
        }
        for (const patch of [{ appearCond: '2004#4294967295' }, { disappearCond: '2004#1' }]) {
            const modified = Object.create(tables)
            modified.get = (name) =>
                name === 'worldmap_104'
                    ? tables.get(name).map((row) => (row.id === 600003 ? { ...row, ...patch } : row))
                    : tables.get(name)
            modified.find = (name, id) =>
                name === 'worldmap_104'
                    ? modified.get(name).find((row) => row.id === Number(id))
                    : tables.find(name, id)
            const state = structuredClone(baseline),
                c = scope(state, f.session, modified),
                before = structuredClone(state)
            assert.throws(() => createWorldObjectAoi(c, { objs: [boss] }), { code: ErrorCode.InvalidTarget })
            assert.deepEqual(state, before)
            assert.deepEqual(c.pushes, [])
        }
        const row = tables.find('worldmap_104', 600003)
        assert(activeTaskWorldBattleSource(tables, baseline, row))
        assert.equal(
            activeTaskWorldBattleSource(tables, { ...baseline, world: { ...baseline.world, map_id: 102 } }, row),
            null,
        )
    } finally {
        f.store.close()
    }
})

test('cleanup ignores valid unissued GUIDs without fabricating receipts, but malformed/kind/previous-connection requests still reject', () => {
    const f = fixture('cleanup-scope')
    try {
        f.call('TryCreateWorldObj', { objs: old })
        f.call('EnterWorldMap', { map_id: 104, point_id: 10401, task_id: 106002, node_id: 59, client_trans_data: 2 })
        const state = f.state(),
            c = scope(state, f.session),
            before = structuredClone(state)
        assert.deepEqual(deleteWorldObjectAoi(c, { u64s: [((3n << 56n) | 9999999n).toString()] }), {})
        assert.deepEqual(state, before)
        assert.deepEqual(c.pushes, [])
        for (const value of ['bad', '0', ((5n << 56n) | 600003n).toString()]) {
            assert.throws(() => deleteWorldObjectAoi(c, { u64s: [value] }))
            assert.deepEqual(state, before)
        }
        assert.throws(() => deleteWorldObjectAoi({ ...c, combatSessionId: 'different-connection' }, { u64s: old }), {
            code: ErrorCode.InvalidTarget,
        })
        assert.deepEqual(state, before)
    } finally {
        f.store.close()
    }
})
