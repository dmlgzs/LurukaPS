import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode, unlockAutomaticTasks, conditionSatisfied, taskSnapshot } from '../src/tasks.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables)
    let session = {},
        seq = 1
    const call = (name, value) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, value) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'task-flow' })
    }
    const packets = login()
    return {
        store,
        call,
        login,
        packets,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
    }
}

test('new main auto-tracks alongside the selected branch and old missing trace migrates on login', () => {
    const f = setup(),
        graph = new TaskGraphs(tables).get(202025)
    try {
        f.edit((s) => {
            s.tasks = [
                {
                    task_id: 202025,
                    nodes: [makeNode(graph, graph.start, s)],
                    finish_nodes: [],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
            s.player.basic_info.lv = 20
            s.taskRecords = tables
                .get('task')
                .filter((row) => row.type === 1 && row.id !== 107016)
                .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
        })
        let packets = f.login(),
            snapshot = protocol.decode('SCTaskSync', packets.find((packet) => packet.id === 9853).payload)
        assert.equal(f.state().tasks.find((task) => task.task_id === 107016).client_trace, true)
        assert.ok(snapshot.trace_list.includes(107016))
        assert.ok(snapshot.trace_list.includes(202025))
        assert.equal(snapshot.next_main_id, 0, 'accepted main is not an unaccepted placeholder')
        f.edit((s) => {
            s.tasks.find((task) => task.task_id === 107016).client_trace = false
        })
        const before = f.state().tasks.find((task) => task.task_id === 107016).nodes
        packets = f.login()
        snapshot = protocol.decode('SCTaskSync', packets.find((packet) => packet.id === 9853).payload)
        assert.ok(snapshot.trace_list.includes(107016))
        assert.ok(snapshot.trace_list.includes(202025))
        assert.deepEqual(f.state().tasks.find((task) => task.task_id === 107016).nodes, before)
        f.call('TaskClientTrace', { task_id: 107016, is_trace: false })
        packets = f.login()
        snapshot = protocol.decode('SCTaskSync', packets.find((packet) => packet.id === 9853).payload)
        assert.ok(!snapshot.trace_list.includes(107016), 'manual untrack survives relog')
        assert.ok(snapshot.trace_list.includes(202025))
    } finally {
        f.store.close()
    }
})
test('late duplicate after for finished prologue node is acknowledged without advancing again', () => {
    const t = setup()
    try {
        const q = { task_id: 106001, node_id: 5 }
        t.call('TaskClientBefore', q)
        const source = t.state().player.heros_info.heros[0].guid
        for (const slot of [0, 1])
            t.call('BattleInfoReduce', {
                uint64_dic: [source, ((4n << 56n) | (BigInt(slot) << 32n) | 10600101n).toString()],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -10000 } }],
            })
        t.call('TaskClientCondAfter', { ...q, indexes: [0] })
        const first = t.call('TaskClientAfter', q).find((x) => x.id === 9862),
            state = t.state()
        assert.equal(state.tasks[0].nodes[0].node_id, 61)
        const duplicate = t.call('TaskClientAfter', q)
        assert.deepEqual(
            duplicate.map((x) => x.id),
            [9862, 9853],
        )
        assert.deepEqual(duplicate[0].payload, first.payload)
        assert.equal(
            protocol.decode('SCTaskSync', duplicate[1].payload).tasks.find((x) => x.task_id === 106001).nodes[0]
                .node_id,
            61,
        )
        assert.deepEqual(t.state(), state)
        t.call('TaskClientBefore', q)
        t.call('TaskClientCondAfter', { ...q, indexes: [0] })
        assert.deepEqual(t.state(), state)
    } finally {
        t.store.close()
    }
})
test('replayed node reward does not present rewards again or grant a second item', () => {
    const t = setup()
    try {
        const graph = new TaskGraphs(tables).get(106001),
            q = { task_id: 106001, node_id: 11 }
        t.edit((s) => {
            s.characterCustomized = true
            s.tasks[0].nodes = [{ ...makeNode(graph, 11, s), client_before: true }]
            s.tasks[0].finish_nodes = [1, 5, 61, 56, 60, 57, 65, 58, 59, 8, 62]
        })
        const first = t.call('TaskClientAfter', q).find((x) => x.id === 9862)
        assert((protocol.decode('cs.Rewards', first.payload).rewards ?? []).length > 0)
        const state = t.state(),
            count = state.player.sbag_infos.items.find((i) => i.itemid === 1000001)?.itemnum
        assert(count > 0)
        const retry = t.call('TaskClientAfter', q).find((x) => x.id === 9862)
        assert.deepEqual(protocol.decode('cs.Rewards', retry.payload).rewards ?? [], [])
        assert.equal(t.state().player.sbag_infos.items.find((i) => i.itemid === 1000001).itemnum, count)
        t.login()
        const relogRetry = t.call('TaskClientAfter', q).find((x) => x.id === 9862)
        assert.deepEqual(protocol.decode('cs.Rewards', relogRetry.payload).rewards ?? [], [])
    } finally {
        t.store.close()
    }
})
test('configured enemy group requires every slot dead then client after-actions advance to configured successor', () => {
    const t = setup()
    try {
        t.call('TaskClientBefore', { task_id: 106001, node_id: 5 })
        const source = t.state().player.heros_info.heros[0].guid
        const hit = (slot) =>
            t.call('BattleInfoReduce', {
                uint64_dic: [source, ((4n << 56n) | (BigInt(slot) << 32n) | 10600101n).toString()],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -10000 } }],
            })
        hit(0)
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 0)
        assert.throws(() => t.call('TaskClientAfter', { task_id: 106001, node_id: 5 }), /conditions/)
        const packets = hit(1)
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 1)
        assert(packets.some((p) => p.id === 9853))
        assert.equal(t.state().tasks[0].nodes[0].node_id, 5)
        // Reproduce old save: both enemies dead but objective receipt absent.
        t.edit((s) => {
            s.taskEvents = {}
            s.tasks[0].nodes[0].node_values = [0]
        })
        t.login()
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 1)
        t.call('TaskClientCondAfter', { task_id: 106001, node_id: 5, indexes: [0] })
        t.call('TaskClientAfter', { task_id: 106001, node_id: 5 })
        assert.equal(t.state().tasks[0].nodes[0].node_id, 61)
    } finally {
        t.store.close()
    }
})
test('migrate live stuck start-node shape to executable node without waiting for nonexistent client callback', () => {
    const t = setup()
    try {
        const graph = new TaskGraphs(tables).get(106001)
        t.edit((s) => {
            const task = s.tasks[0]
            task.nodes = [makeNode(graph, 1, s)]
            task.finish_nodes = []
            task.start_time = 123
        })
        const packets = t.login(),
            sync = protocol.decode('SCTaskSync', packets.find((p) => p.id === 9853).payload),
            task = sync.tasks.find((q) => q.task_id === 106001)
        assert.deepEqual(task.finish_nodes, [1])
        assert.equal(task.nodes[0].node_id, 5)
        assert.equal(task.nodes[0].client_before, false)
        assert.equal(task.start_time, 123)
        t.call('MultiTaskClientBefore', { task_params: [{ task_id: 106001, node_id: 5 }] })
        const saved = t.state().tasks
        t.login()
        assert.deepEqual(t.state().tasks, saved)
    } finally {
        t.store.close()
    }
})
test('fractal catch uses two stages and owned configured pet; page close uses task-scoped report', () => {
    const t = setup()
    try {
        const g = new TaskGraphs(tables).get(106002)
        t.edit((s) => {
            s.world.map_id = 102
            s.tasks = [
                {
                    task_id: 106002,
                    nodes: [{ ...makeNode(g, 56, s), client_before: true }],
                    finish_nodes: [1],
                    reward_nodes: [],
                },
            ]
        })
        const q = g.nodes.get(56).__type_TaskConditionNodeData.conditionList[0],
            d = q.__type_TaskConditionBaseData.__type_TaskCondFractalPetCatchData
        const event = { key: 2526, args: [106002, d.enemyData.createNpcId, d.uniKey, 1] }
        t.call('ClientBehaviourRecord', event)
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 1)
        assert(!conditionSatisfied(q, 1))
        assert.throws(() => t.call('TaskClientAfter', { task_id: 106002, node_id: 56 }), /conditions/)
        const pets = t.state().pets
        t.edit((s) => {
            s.pets = []
        })
        assert.throws(
            () => t.call('ClientBehaviourRecord', { ...event, args: [...event.args.slice(0, 3), 2] }),
            /not owned/,
        )
        t.edit((s) => {
            s.pets = pets
        })
        t.call('ClientBehaviourRecord', { ...event, args: [...event.args.slice(0, 3), 2] })
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 2)
        t.call('ClientBehaviourRecord', event)
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 2)
        t.edit((s) => {
            s.tasks[0].nodes = [{ ...makeNode(g, 65, s), client_before: true }]
        })
        t.call('ClientBehaviourRecord', { key: 2508, args: [106002, 1] })
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 1)
        t.login()
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 1)
    } finally {
        t.store.close()
    }
})
test('fresh and existing empty accounts receive initial main quest once, with trace and login sync', () => {
    const t = setup()
    try {
        let state = t.state()
        assert.deepEqual(
            state.tasks.map((t) => t.task_id),
            [106001],
        )
        assert.equal(state.tasks[0].client_trace, true)
        const sync = protocol.decode('SCTaskSync', t.packets.find((p) => p.id === 9853).payload)
        assert.equal(sync.next_main_id, 0)
        assert.deepEqual(sync.trace_list, [106001])
        assert.deepEqual(state.tasks[0].finish_nodes, [1])
        assert.equal(state.tasks[0].nodes[0].node_id, 5)
        t.call('MultiTaskClientBefore', { task_params: [{ task_id: 106001, node_id: 5 }] })
        const progress = t.state().tasks
        t.login()
        assert.deepEqual(t.state().tasks, progress)
        assert.equal(t.state().taskEpochs[106001], 1)
        t.edit((s) => {
            s.tasks = []
        })
        t.login()
        assert.deepEqual(
            t.state().tasks.map((t) => t.task_id),
            [106001],
        )
    } finally {
        t.store.close()
    }
})

test('completed story shows the next level-gated main quest and accepts it at the configured level', () => {
    const t = setup()
    try {
        t.edit((state) => {
            state.tasks = []
            state.taskRecords = [106001, 106002, 106009, 106010, 106012, 106013, 996001].map((task_id) => ({
                task_id,
                count: 1,
                time: 1,
            }))
            state.player.basic_info.lv = 14
        })
        let packets = t.login()
        let sync = protocol.decode('SCTaskSync', packets.find((packet) => packet.id === 9853).payload)
        assert.equal(sync.next_main_id, 106014)
        assert.ok(!sync.tasks.some((task) => task.task_id === 106014))
        assert.ok(!t.state().tasks.some((task) => task.task_id === 106014))
        assert.throws(() => t.call('TaskAccept', { u32: 106014 }), /prerequisites/)

        t.edit((state) => {
            state.player.basic_info.lv = 15
        })
        packets = t.login()
        sync = protocol.decode('SCTaskSync', packets.find((packet) => packet.id === 9853).payload)
        assert.equal(sync.next_main_id, 0)
        assert.ok(sync.tasks.some((task) => task.task_id === 106014))
        assert.equal(t.state().taskEpochs[106014], 1)

        t.edit((state) => {
            state.tasks = []
            state.taskRecords.push({ task_id: 106014, count: 1, time: 1 }, { task_id: 106015, count: 1, time: 1 })
            state.player.basic_info.lv = 19
        })
        assert.equal(taskSnapshot(tables, t.state()).next_main_id, 106016)
        t.edit((state) => {
            state.taskRecords = state.taskRecords.filter((record) => record.task_id !== 106015)
        })
        assert.equal(taskSnapshot(tables, t.state()).next_main_id, 0)
    } finally {
        t.store.close()
    }
})

test('an old underleveled active main is shown as a level placeholder until leveling', () => {
    const t = setup()
    try {
        t.edit((state) => {
            state.player.basic_info.lv = 8
            state.taskRecords = [106001, 106002, 106009, 106010, 106012, 106013, 996001].map((task_id) => ({
                task_id,
                count: 1,
                time: 1,
            }))
            state.tasks = [
                {
                    task_id: 106014,
                    nodes: [{ node_id: 3, node_values: [0] }],
                    finish_nodes: [1],
                    reward_nodes: [],
                    client_trace: true,
                    start_time: 1,
                },
            ]
            state.taskEpochs[106014] = 1
        })
        const packets = t.login()
        const sync = protocol.decode('SCTaskSync', packets.find((packet) => packet.id === 9853).payload)
        assert.equal(sync.next_main_id, 106014)
        assert.ok(!sync.tasks.some((task) => task.task_id === 106014))
        assert.deepEqual(sync.del_tasks, [106014])
        assert.deepEqual(sync.del_trace_list, [106014])
        assert.ok(t.state().tasks.some((task) => task.task_id === 106014))

        const encode = (value) => Buffer.from(String(value)).toString('base64')
        const upgraded = t.call('GMCommand', { command: encode('level'), args: [encode(15)] })
        const taskPackets = upgraded.filter((packet) => packet.id === 9853)
        assert.ok(taskPackets.length > 0)
        const restored = protocol.decode('SCTaskSync', taskPackets.at(-1).payload)
        assert.ok(restored.tasks.some((task) => task.task_id === 106014))
        assert.equal(restored.next_main_id, 0)
        assert.deepEqual(restored.new_task_ids, [106014])
        assert.equal(t.state().taskEpochs[106014], 1)
    } finally {
        t.store.close()
    }
})
test('completed main quest unlocks its successor atomically without replaying prior quests', () => {
    const t = setup()
    try {
        t.edit((s) => {
            const g = new TaskGraphs(tables).get(106001),
                task = s.tasks[0]
            task.nodes = [{ ...makeNode(g, g.end, s), client_before: true }]
            task.final_time = 1
        })
        t.call('TaskFinish', { u32: 106001 })
        assert.deepEqual(
            t.state().tasks.map((t) => t.task_id),
            [106002],
        )
        assert.equal(t.state().taskRecords[0].count, 1)
        const before = t.state()
        assert.throws(() => t.call('TaskAccept', { u32: 106009 }), /prerequisites/)
        assert.deepEqual(t.state(), before)
        t.login()
        assert.deepEqual(
            t.state().tasks.map((t) => t.task_id),
            [106002],
        )
    } finally {
        t.store.close()
    }
})
test('actual prologue end55 completes through direct TaskFinish, then repeated claim stays once-only', () => {
    const t = setup()
    try {
        const graph = new TaskGraphs(tables).get(106001)
        t.edit((s) => {
            s.tasks[0].nodes = [makeNode(graph, 55, s)]
            s.tasks[0].finish_nodes = [1, 5, 61, 56, 60, 57, 65, 58, 59, 8, 62, 11, 63, 64, 54]
            delete s.tasks[0].final_time
        })
        const first = t.call('TaskFinish', { u32: 106001 }).find((x) => x.id === 9852),
            state = t.state()
        assert(state.tasks.some((q) => q.task_id === 106002))
        assert.equal(state.taskRecords.find((q) => q.task_id === 106001).count, 1)
        const again = t.call('TaskFinish', { u32: 106001 }).find((x) => x.id === 9852)
        assert.deepEqual(again.payload, first.payload)
        assert.deepEqual(t.state(), state)
        t.login()
        assert.equal(t.state().taskRecords.find((q) => q.task_id === 106001).count, 1)
    } finally {
        t.store.close()
    }
})
test('CBT3 indexed NPC events update only matching active condition and persist across login', () => {
    const t = setup()
    try {
        const graph = new TaskGraphs(tables).get(106001)
        t.edit((s) => {
            s.world.map_id = 102
            s.tasks[0].nodes = [{ ...makeNode(graph, 8, s), client_before: true }]
        })
        const event = { key: 2519, args: [106001008, 106001, 8, 0, 1] },
            before = t.state()
        assert.throws(() => t.call('ClientBehaviourRecord', { ...event, args: [999, 106001, 8, 0, 1] }), /target/)
        assert.deepEqual(t.state(), before)
        const packets = t.call('ClientBehaviourRecord', event)
        assert(packets.some((p) => p.id === 9853))
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 1)
        t.call('ClientBehaviourRecord', event)
        t.login()
        assert.equal(t.state().tasks[0].nodes[0].node_values[0], 1)
        t.call('MultiTaskClientCondAfter', { task_params: [{ task_id: 106001, node_id: 8, indexes: [0] }] })
        t.call('MultiTaskClientAfter', { task_params: [{ task_id: 106001, node_id: 8 }] })
        assert.equal(t.state().tasks[0].nodes[0].node_id, 62)
    } finally {
        t.store.close()
    }
})
test('leaving Luluka home satisfies the configured destination scene and advances quest 106009', () => {
    const t = setup()
    try {
        const graph = new TaskGraphs(tables).get(106009),
            q = { task_id: 106009, node_id: 4 }
        t.edit((s) => {
            s.world.map_id = 200
            s.world.point_id = 20004
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
            ]
            s.taskEpochs[106009] = 1
            s.tasks = [
                {
                    task_id: 106009,
                    nodes: [
                        { ...makeNode(graph, 4, s), node_values: [0], client_before: true, client_cond_after: [false] },
                    ],
                    finish_nodes: [1, 3],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        const sync = t.login().find((p) => p.id === 9853),
            task = protocol.decode('SCTaskSync', sync.payload).tasks.find((x) => x.task_id === 106009)
        assert.equal(t.state().world.map_id, 200)
        assert.equal(task.nodes[0].node_values[0], 1)
        assert.throws(() => t.call('ClientBehaviourRecord', { key: 2519, args: [251, 106009, 4, 0, 1] }), /target/)
        t.call('ClientBehaviourRecord', { key: 2519, args: [200, 106009, 4, 0, 1] })
        t.call('TaskClientCondAfter', { ...q, indexes: [0] })
        t.call('TaskClientAfter', q)
        assert.equal(t.state().tasks[0].nodes[0].node_id, 7)
        const state = t.state()
        t.call('ClientBehaviourRecord', { key: 2519, args: [200, 106009, 4, 0, 1] })
        assert.deepEqual(t.state(), state)
    } finally {
        t.store.close()
    }
})
test('quest 106009 grants its configured hero then 900 experience and unlocks the next quest', () => {
    const t = setup()
    try {
        const graph = new TaskGraphs(tables).get(106009)
        t.edit((s) => {
            s.world.map_id = 200
            s.world.point_id = 200001
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
            ]
            s.taskEpochs[106009] = 1
            s.tasks = [
                {
                    task_id: 106009,
                    nodes: [{ ...makeNode(graph, 8, s), client_before: true }],
                    finish_nodes: [1, 3, 4, 7],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        t.call('ClientBehaviourRecord', { key: 2519, args: [106009008, 106009, 8, 0, 1] })
        t.call('TaskClientCondAfter', { task_id: 106009, node_id: 8, indexes: [0] })
        t.call('TaskClientAfter', { task_id: 106009, node_id: 8 })
        assert.equal(t.state().tasks[0].nodes[0].node_id, 10)
        t.call('EnterWorldMap', { map_id: 100, point_id: 10045, task_id: 106009, node_id: 10, client_trans_data: 2 })
        t.call('TaskClientBefore', { task_id: 106009, node_id: 10 })
        t.call('ClientBehaviourRecord', { key: 2519, args: [100, 106009, 10, 0, 1] })
        t.call('TaskClientCondAfter', { task_id: 106009, node_id: 10, indexes: [0] })
        t.call('TaskClientAfter', { task_id: 106009, node_id: 10 })
        const hero = t.state().player.heros_info.heros.filter((h) => h.conf_id === 108001)
        assert.equal(hero.length, 1)
        assert.equal(t.state().tasks[0].nodes[0].node_id, 9)
        t.call('TaskClientAfter', { task_id: 106009, node_id: 10 })
        assert.equal(t.state().player.heros_info.heros.filter((h) => h.conf_id === 108001).length, 1)
        const packets = t.call('TaskFinish', { u32: 106009 }),
            basic = t.state().player.basic_info
        assert.equal(basic.lv, 3)
        assert.equal(basic.exp, 200)
        assert(t.state().tasks.some((q) => q.task_id === 106010))
        const sync = packets.find((p) => p.id === 5008 && protocol.decode('PlayerData', p.payload).basic_info?.lv === 3)
        assert(sync)
        assert.equal(protocol.decode('PlayerData', sync.payload).basic_info.exp, 200)
    } finally {
        t.store.close()
    }
})
test('quest 106010 node78 grants configured customized pet before advancing', () => {
    const t = setup()
    try {
        const graph = new TaskGraphs(tables).get(106010),
            q = { task_id: 106010, node_id: 78 }
        t.edit((s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.taskEvents ??= {}
            s.taskEvents['106010:1:78:0'] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 78, s), client_before: true, client_cond_after: [true] }],
                    finish_nodes: [3, 74],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        const before = t.state().pets.length,
            packets = t.call('TaskClientAfter', q),
            state = t.state(),
            pet = state.pets.find((p) => p.customized_id === 500072)
        assert.equal(state.pets.length, before + 1)
        assert.equal(pet.config_id, 500072)
        assert.equal(pet.satiety_val, 60)
        assert.equal(pet.can_not_release, true)
        assert.deepEqual(Object.fromEntries(pet.comprehension.map((x) => [x.attr_id, x.level])), {
            1: 7,
            3: 4,
            5: 4,
            7: 7,
            229: 4,
            230: 4,
        })
        assert.deepEqual(
            pet.gene_infos.map((x) => x.gene_id),
            [532048, 533003, 533036, 533026, 533008, 533040, 533001, 533076],
        )
        assert.equal(state.tasks[0].nodes[0].node_id, 149)
        assert(state.tasks[0].reward_nodes.includes(78))
        const petSync = packets.findIndex((p) => p.id === 6517),
            reply = packets.findIndex((p) => p.id === 9862)
        assert(petSync >= 0 && petSync < reply)
        t.call('TaskClientAfter', q)
        assert.equal(t.state().pets.length, before + 1)
    } finally {
        t.store.close()
    }
})
test('invalid batch rolls back preceding callbacks; level unlocks do not reset active quests', () => {
    const t = setup()
    try {
        const before = t.state()
        assert.throws(() =>
            t.call('MultiTaskClientBefore', {
                task_params: [
                    { task_id: 106001, node_id: 5 },
                    { task_id: 106001, node_id: 999 },
                ],
            }),
        )
        assert.deepEqual(t.state(), before)
        t.edit((s) => {
            s.player.basic_info.lv = 25
            unlockAutomaticTasks(tables, s, 1)
        })
        assert(t.state().tasks.some((t) => t.task_id === 400201))
        assert(!t.state().tasks.some((t) => t.task_id === 400202))
    } finally {
        t.store.close()
    }
})
test('initial main quest runs from entry through NPC and battle reports, customization, inventory reward and successor', () => {
    const t = setup()
    try {
        t.edit((s) => {
            s.world.map_id = 102
        })
        const graph = new TaskGraphs(tables).get(106001)
        let visited = 0
        while (t.state().tasks.some((q) => q.task_id === 106001) && visited++ < 40) {
            const task = t.state().tasks.find((q) => q.task_id === 106001),
                node = task.nodes[0],
                config = graph.nodes.get(node.node_id),
                request = { task_id: 106001, node_id: node.node_id }
            t.call('MultiTaskClientBefore', { task_params: [request] })
            const raw = config.__type_TaskConditionNodeData?.conditionList,
                conditions = raw ? (Array.isArray(raw) ? raw : [raw]) : []
            for (let index = 0; index < conditions.length; index++) {
                const c = conditions[index],
                    b = c.__type_TaskConditionBaseData
                if (c.conditionId === 2505) t.call('PlayerCustomData', { name: 'QuestPlayer' })
                else {
                    assert([2519, 2520].includes(c.conditionId))
                    const d = b.__type_TaskCondActiveNPCTriggerData ?? b.__type_TaskCondEnemiesGroupData
                    const target = c.conditionId === 2519 && d.isNowCreate ? d.npcData.createNpcId : d.createNpcId
                    t.call('ClientBehaviourRecord', {
                        key: c.conditionId,
                        args: [target, 106001, node.node_id, index, 1],
                    })
                }
            }
            if (conditions.length)
                t.call('MultiTaskClientCondAfter', {
                    task_params: [{ ...request, indexes: conditions.map((_, i) => i) }],
                })
            const packets = config.nodeType === 50 ? [] : t.call('MultiTaskClientAfter', { task_params: [request] })
            if (node.node_id === 11) {
                const s = t.state(),
                    item = s.player.sbag_infos.items.find((i) => i.itemid === 1000001)
                assert(item?.itemnum > 0)
                const n = item.itemnum
                assert(
                    packets.findIndex((p) => p.id === protocol.byName.get('CSProtoSyncPlayerData').id) <
                        packets.findIndex((p) => p.id === 9882),
                )
                const bagPacket = packets.find(
                    (p) =>
                        p.id === 5008 &&
                        protocol.decode('PlayerData', p.payload).sbag_infos?.items?.some((x) => x.itemid === 1000001),
                )
                assert(bagPacket)
                assert(
                    protocol.decode('PlayerData', bagPacket.payload).sbag_infos.items.find((x) => x.itemid === 1000001)
                        .guid !== '0',
                )
                t.call('TaskRewardNode', request)
                assert.equal(t.state().player.sbag_infos.items.find((i) => i.itemid === 1000001).itemnum, n)
            }
            if (config.nodeType === 50) {
                assert.equal(t.state().tasks.find((q) => q.task_id === 106001).nodes[0].node_id, graph.end)
                t.call('TaskFinish', { u32: 106001 })
            }
        }
        assert(visited < 40)
        assert(t.state().tasks.some((q) => q.task_id === 106002))
        assert.equal(t.state().taskRecords.find((q) => q.task_id === 106001).count, 1)
    } finally {
        t.store.close()
    }
})
