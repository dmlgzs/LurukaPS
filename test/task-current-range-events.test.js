import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode, nodeConditions, asList } from '../src/tasks.js'
import {
    taskRangeContains,
    validateTaskRangeEvent,
    validateTaskPlayableStepEvent,
    validateTaskConditionEventPolicy,
} from '../src/task-condition-events.js'
import taskConditionPolicy from '../configs/task-condition-event-policy.json' with { type: 'json' }
import { deliveryKey } from '../src/task-delivery.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables),
    graphs = new TaskGraphs(tables)
const code = (expected) => (error) => error.code === expected
const cm = (position) => Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, Math.round(position[axis] * 100)]))

test('current custom shapes preserve native3D strict radius and box/cylinder height boundaries without an unrelated interaction tolerance', () => {
    const data = { position: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 4, z: 6 }, shapeType: 1 }
    assert(taskRangeContains(data, { x: 0, y: 199, z: 0 }))
    assert(
        !taskRangeContains(data, { x: 0, y: 200, z: 0 }),
        'Circle enum uses full3D distance, not an infiniteXZ circle',
    )
    assert(!taskRangeContains(data, { x: 200, y: 0, z: 0 }))
    assert(taskRangeContains(data, { x: 299, y: 0, z: 0 }, 1))
    assert(!taskRangeContains(data, { x: 300, y: 0, z: 0 }, 1))
    data.shapeType = 2
    assert(taskRangeContains(data, { x: 100, y: 200, z: 300 }))
    assert(!taskRangeContains(data, { x: 101, y: 0, z: 0 }))
    assert(!taskRangeContains(data, { x: 0, y: 201, z: 0 }))
    assert(taskRangeContains(data, { x: 200, y: 300, z: 400 }, 1))
    data.shapeType = 3
    assert(taskRangeContains(data, { x: 0, y: 200, z: 0 }))
    assert(!taskRangeContains(data, { x: 0, y: 201, z: 0 }))
    assert(!taskRangeContains(data, { x: 200, y: 0, z: 0 }))
    assert(taskRangeContains(data, { x: 299, y: 300, z: 0 }, 1))
    assert(!taskRangeContains(data, { x: 0, y: 301, z: 0 }, 1))
    assert.throws(
        () => taskRangeContains({ ...data, shapeType: 0 }, { x: 0, y: 0, z: 0 }),
        code(ErrorCode.FunctionClosed),
    )
    assert.throws(() => taskRangeContains({ ...data, scale: null }, { x: 0, y: 0, z: 0 }), code(ErrorCode.GameConfig))
})

test('all current range conditions bind either actual hero geometry or the explicit LOCAL registered NPC metadata policy', () => {
    let players = 0,
        npcs = 0
    for (const row of tables.get('task'))
        for (const node of graphs.get(row.id).nodes.values())
            for (const condition of nodeConditions(node)) {
                const data = condition.__type_TaskConditionBaseData?.__type_TaskCondRangeTriggerData
                if (!data) continue
                const position = cm(data.position)
                const active = { node_id: node.id, client_before: true }
                const task = { task_id: row.id, client_trace: true, nodes: [active] }
                const c = {
                    tables,
                    state: { world: { map_id: condition.__type_TaskConditionBaseData.mapData.sceneId, pos: position } },
                }
                if (data.listenObject === -1) {
                    assert(taskRangeContains(data, position))
                    const outside = { ...position, x: position.x + Math.ceil(Math.abs(data.scale.x) * 300 + 100) }
                    assert(!taskRangeContains(data, outside))
                    validateTaskRangeEvent(c, task, data, 0, { graph: graphs.get(row.id), node: active })
                    players++
                } else {
                    assert.throws(() => validateTaskRangeEvent(c, task, data, 0), code(ErrorCode.InvalidArgument))
                    validateTaskRangeEvent(c, task, data, 0, { graph: graphs.get(row.id), node: active })
                    npcs++
                }
            }
    assert.equal(players, 12)
    assert.equal(npcs, 4)
})

function fixture(taskId, nodeId, map) {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        graph = graphs.get(taskId)
    let sequence = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, request) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    call('EnterGame', { open_id: `current-task-event-${taskId}` })
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.world.map_id = map
        s.player.basic_info.lv = 30
        s.taskEpochs ??= {}
        s.taskEpochs[taskId] = 1
        s.tasks = [
            {
                task_id: taskId,
                start_time: 1800000000,
                nodes: [makeNode(graph, nodeId, s)],
                finish_nodes: asList(graph.nodes.get(nodeId).prevNodeIdList),
                reward_nodes: [],
                client_trace: false,
            },
        ]
    })
    const task = () => state().tasks.find((row) => row.task_id === taskId)
    const event = (target, node = nodeId, index = 0) =>
        call('ClientBehaviourRecord', { key: 2519, args: [target, taskId, node, index, 1] })
    const move = (position, uuid) => {
        const s = state(),
            manager = s.player.group_mgrs.find((row) => row.type === 1),
            control = manager.groups.find((row) => row.id === manager.cur_group).control
        return call('StateUpdate', {
            move_msg: { map_id: map, move: [{ uuid: uuid ?? control, info: { pos: position, angle: 0 } }] },
        })
    }
    return { protocol, store, graph, call, state, edit, task, event, move }
}

test('actual202005 range report needs traced active scope and accepted controlling movement; stale movement, wrong target and codec failures cannot finish it', () => {
    const f = fixture(202005, 8, 101),
        data = nodeConditions(f.graph.nodes.get(8))[0].__type_TaskConditionBaseData.__type_TaskCondRangeTriggerData
    const center = cm(data.position),
        outside = { ...center, x: center.x + 1000 }
    const withinLocalMargin = { ...center, x: center.x + Math.round((Math.abs(data.scale.x) + 0.5) * 100) }
    try {
        f.call('TaskClientBefore', { task_id: 202005, node_id: 8 })
        f.move(center)
        assert.throws(() => f.event(0), code(ErrorCode.InvalidArgument))
        f.call('TaskClientTrace', { task_id: 202005, is_trace: true })
        f.move(outside)
        const stale = structuredClone(f.state())
        assert.throws(() => f.event(0), code(ErrorCode.InvalidArgument))
        assert.deepEqual(f.state(), stale)
        f.move(center, '999999999')
        assert.deepEqual(f.state().world.pos, outside, 'Another unit cannot supply controlling-hero position')
        assert.throws(() => f.event(0), code(ErrorCode.InvalidArgument))
        f.move(withinLocalMargin)
        assert(!taskRangeContains(data, f.state().world.pos), 'This point is outside the native zero-tolerance range')
        assert(taskRangeContains(data, f.state().world.pos, taskConditionPolicy.player_position_tolerance_meters))
        assert.throws(() => f.event(99), code(ErrorCode.InvalidArgument))
        const before = structuredClone(f.state()),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byName.get('CSProtoTaskSync').rsp) throw Error('range-event-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.event(0), /range-event-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), before)
        f.event(0)
        const key = deliveryKey(f.state(), 202005, 8, 0)
        assert.equal(f.state().taskEvents[key], 1)
        assert.equal(f.task().nodes.find((row) => row.node_id === 8).node_values[0], 1)
        f.move(outside)
        f.event(0)
        assert.equal(f.state().taskEvents[key], 1, 'An already accepted scoped event replays without new range credit')
        f.call('TaskClientCondAfter', { task_id: 202005, node_id: 8, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 202005, node_id: 8 })
        assert(f.task().finish_nodes.includes(8))
        f.event(0)
        assert.equal(f.state().taskEvents[key], 1)
    } finally {
        f.store.close()
    }
})

test('actual574 server steps open102028 nodes23/24 only at their own thresholds; bare success or other scene progress is not evidence', () => {
    const f = fixture(102028, 23, 6216)
    try {
        f.call('TaskClientBefore', { task_id: 102028, node_id: 23 })
        const before = structuredClone(f.state())
        assert.throws(() => f.event(574, 23), code(ErrorCode.InvalidArgument))
        assert.deepEqual(f.state(), before)
        f.call('PlayableStart', { u32: 574 })
        assert.throws(() => f.event(574, 23), code(ErrorCode.InvalidArgument))
        assert.throws(() => f.event(575, 23), code(ErrorCode.InvalidArgument))
        f.call('PlayableStep', { playId: 574, is_step: true, finish_step: 1 })
        f.event(574, 23)
        assert.equal(f.state().taskEvents[deliveryKey(f.state(), 102028, 23, 0)], 1)
        f.call('TaskClientCondAfter', { task_id: 102028, node_id: 23, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 102028, node_id: 23 })
        assert(f.task().nodes.some((row) => row.node_id === 24))
        f.call('TaskClientBefore', { task_id: 102028, node_id: 24 })
        f.call('PlayableStep', { playId: 574, is_step: true, finish_step: 2 })
        assert.throws(() => f.event(574, 24), code(ErrorCode.InvalidArgument))
        f.call('PlayableStep', { playId: 574, is_step: true, finish_step: 3 })
        const snapshot = structuredClone(f.state()),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byName.get('CSProtoTaskSync').rsp) throw Error('playable-step-event-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.event(574, 24), /playable-step-event-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), snapshot)
        f.event(574, 24)
        f.event(574, 24)
        assert.equal(f.state().taskEvents[deliveryKey(f.state(), 102028, 24, 0)], 1)
        f.call('TaskClientCondAfter', { task_id: 102028, node_id: 24, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 102028, node_id: 24 })
        assert(f.task().finish_nodes.includes(24))
    } finally {
        f.store.close()
    }
})

test('playable completion fallback is source-owned and scoped; malformed progress and wrong-scene finishes are distinct from unmet progress', () => {
    const data = { playableID: 574, sceneID: 6216, step: 3 },
        c = { tables, state: { world: { map_id: 6216 } } }
    assert.throws(() => validateTaskPlayableStepEvent(c, data), code(ErrorCode.InvalidArgument))
    c.state.playableFinishes = { 574: { play_id: 574, map_id: 6216 } }
    validateTaskPlayableStepEvent(c, data)
    c.state.playableFinishes[574].map_id = 100
    assert.throws(() => validateTaskPlayableStepEvent(c, data), code(ErrorCode.InvalidArgument))
    c.state.playableRuns = { 574: { play_id: 574, map_id: 6216, status: 1, finish_step: '3' } }
    assert.throws(() => validateTaskPlayableStepEvent(c, data), code(ErrorCode.GameConfig))
})

test('LOCAL NPC authority is explicitly switchable and requires acknowledged unique active scope and the complete current resource chain', () => {
    const graph = graphs.get(231002),
        config = graph.nodes.get(29)
    const data = nodeConditions(config)[0].__type_TaskConditionBaseData.__type_TaskCondRangeTriggerData
    const node = { node_id: 29, client_before: true },
        task = { task_id: 231002, client_trace: true, nodes: [node] }
    const c = { tables, state: { world: { map_id: 101, pos: { x: -99999, y: 0, z: -99999 } } } }
    validateTaskRangeEvent(c, task, data, 0, { graph, node })
    assert.throws(
        () =>
            validateTaskRangeEvent(
                c,
                task,
                data,
                0,
                { graph, node },
                { ...taskConditionPolicy, npc_range_enabled: false },
            ),
        code(ErrorCode.FunctionClosed),
    )
    for (const patch of [
        { origin: 'OFFICIAL' },
        { schema_version: 0 },
        { npc_range_authority: 'trust-any-report' },
        ...[-1, '1', Infinity, NaN].map((value) => ({ player_position_tolerance_meters: value })),
    ])
        assert.throws(
            () => validateTaskConditionEventPolicy({ ...taskConditionPolicy, ...patch }),
            code(ErrorCode.GameConfig),
        )
    validateTaskConditionEventPolicy({ ...taskConditionPolicy, player_position_tolerance_meters: 0 })
    node.client_before = false
    assert.throws(() => validateTaskRangeEvent(c, task, data, 0, { graph, node }), code(ErrorCode.InvalidArgument))
    node.client_before = true
    task.client_trace = false
    assert.throws(() => validateTaskRangeEvent(c, task, data, 0, { graph, node }), code(ErrorCode.InvalidArgument))
    task.client_trace = true
    for (const npcs of [
        [],
        [
            graph.npcs.find((row) => row.createNpcId === data.listenObject),
            graph.npcs.find((row) => row.createNpcId === data.listenObject),
        ],
    ])
        assert.throws(
            () => validateTaskRangeEvent(c, task, data, 0, { graph: { ...graph, npcs }, node }),
            code(ErrorCode.GameConfig),
        )
    const scoped = graph.npcs.map((row) =>
        row.createNpcId === data.listenObject ? { ...row, overrideNodeIds: [43] } : row,
    )
    assert.throws(
        () => validateTaskRangeEvent(c, task, data, 0, { graph: { ...graph, npcs: scoped }, node }),
        code(ErrorCode.InvalidArgument),
    )
    for (const missing of ['worldmap_101', 'world_spawner', 'unit']) {
        const source = Object.create(tables)
        source.find = (name, id) => (name === missing ? undefined : tables.find(name, id))
        assert.throws(
            () => validateTaskRangeEvent({ ...c, tables: source }, task, data, 0, { graph, node }),
            code(ErrorCode.GameConfig),
        )
    }
})

test('four actual231002 NPC range reports progress29→40→41→42 under LOCAL scoped client authority, without invented NPC coordinates', () => {
    const f = fixture(231002, 29, 101),
        originalPosition = structuredClone(f.state().world.pos)
    try {
        assert.throws(() => f.event(0, 29), code(ErrorCode.InvalidArgument))
        f.call('TaskClientTrace', { task_id: 231002, is_trace: true })
        assert.throws(() => f.event(0, 29), code(ErrorCode.InvalidArgument))
        for (const id of [29, 40, 41, 42]) {
            f.call('TaskClientBefore', { task_id: 231002, node_id: id })
            const bad = structuredClone(f.state())
            assert.throws(
                () => f.event(231002016, id),
                code(ErrorCode.InvalidArgument),
                'Native sender target is createNpcId0, not listenObject',
            )
            assert.throws(() => f.event(0, id, 1), code(ErrorCode.InvalidArgument))
            assert.deepEqual(f.state(), bad)
            if (id === 29) {
                f.edit((state) => {
                    state.world.map_id = 102
                })
                assert.throws(() => f.event(0, id), code(ErrorCode.InvalidArgument))
                f.edit((state) => {
                    state.world.map_id = 101
                })
            }
            if (id === 40) {
                const saved = structuredClone(f.state()),
                    encode = f.protocol.encode
                f.protocol.encode = function (name, value) {
                    if (name === f.protocol.byName.get('CSProtoTaskSync').rsp) throw Error('npc-range-policy-codec')
                    return encode.call(this, name, value)
                }
                try {
                    assert.throws(() => f.event(0, id), /npc-range-policy-codec/)
                } finally {
                    f.protocol.encode = encode
                }
                assert.deepEqual(f.state(), saved)
            }
            f.event(0, id)
            f.event(0, id)
            assert.equal(f.state().taskEvents[deliveryKey(f.state(), 231002, id, 0)], 1)
            f.call('TaskClientCondAfter', { task_id: 231002, node_id: id, indexes: [0] })
            f.call('TaskClientAfter', { task_id: 231002, node_id: id })
            assert(f.task().finish_nodes.includes(id))
            assert.deepEqual(
                f.state().world.pos,
                originalPosition,
                'No player or initial NPC pose is used as an escort trajectory',
            )
        }
        assert(f.task().nodes.some((node) => node.node_id === 43))
    } finally {
        f.store.close()
    }
})
