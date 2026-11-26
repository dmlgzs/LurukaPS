import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode, asList } from '../src/tasks.js'
import { taskBranchExit } from '../src/task-branch-flow.js'
import { deliveryKey } from '../src/task-delivery.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables),
    graphs = new TaskGraphs(tables)
const conditionData = (node) => node.__type_TaskConditonBranchNodeData
const code = (expected) => (error) => error.code === expected
function choose(graph, node, indexes) {
    const count = conditionData(node).conditionList.length
    return taskBranchExit(
        graph,
        node,
        { client_cond_after: Array.from({ length: count }, (_, i) => indexes.includes(i)) },
        Array.from({ length: count }, (_, i) => (indexes.includes(i) ? 1 : 0)),
        Array(count).fill(1),
    )
}

test('all four current nonempty single-target mappings use explicit condition indexes, including shuffled boxes and duplicate exits', () => {
    let checked = 0
    for (const [taskId, nodeId] of [
        [106010, 148],
        [213010, 15],
        [214001, 20],
        [400101, 6],
    ]) {
        const graph = graphs.get(taskId),
            original = graph.nodes.get(nodeId)
        for (const reverse of [false, true]) {
            const node = structuredClone(original)
            if (reverse) conditionData(node).branchNodeList.multiArray.reverse()
            for (let index = 0; index < conditionData(node).conditionList.length; index++) {
                assert.deepEqual(choose(graph, node, [index]), {
                    indexes: [index],
                    next: [asList(original.nextNodeIdList)[index]],
                })
                checked++
            }
        }
    }
    assert.equal(checked, 18)
    assert.deepEqual(choose(graphs.get(214001), graphs.get(214001).nodes.get(20), [0, 1]), {
        indexes: [0, 1],
        next: [14],
    })
    assert.deepEqual(choose(graphs.get(400101), graphs.get(400101).nodes.get(6), [0, 1]), {
        indexes: [0, 1],
        next: [5],
    })
})

test('bad indexes, row lengths, missing boxes, disagreeing metadata and dangling exits cannot generate successors', () => {
    const graph = graphs.get(106010),
        source = graph.nodes.get(148)
    const mutate = [
        (data) => {
            data.branchNodeList.multiArray[0].listStartNumber = 3
        },
        (data) => {
            data.branchNodeList.multiArray[0].listStartNumber = 1
        },
        (data) => {
            data.branchNodeList.multiArray[0].listStartNumber = -1
        },
        (data) => {
            data.branchNodeList.multiArray.pop()
        },
        (data) => {
            data.branchNodeList.saveLen[0] = 2
        },
        (data) => {
            data.branchNodeList.multiArray[0].saveLen = [999999]
        },
        (data) => {
            data.branchNodeList.multiArray[0].saveLen = [182]
        },
        (data) => {
            data.conditionList[0].index = 7
        },
    ]
    for (const edit of mutate) {
        const node = structuredClone(source)
        edit(conditionData(node))
        assert.throws(() => choose(graph, node, [0]), code(ErrorCode.GameConfig))
    }
    assert.throws(() => choose(graph, source, []), code(ErrorCode.InvalidArgument))
    assert.throws(
        () => taskBranchExit(graph, source, { client_cond_after: [true, false, false] }, [0, 0, 0], [1, 1, 1]),
        code(ErrorCode.InvalidArgument),
    )
})

test('different successful exits and unproven multi-target rows remain explicit unsupported capabilities', () => {
    const graph = graphs.get(106010),
        source = graph.nodes.get(148)
    assert.throws(() => choose(graph, source, [0, 1]), code(ErrorCode.FunctionClosed))
    const multi = structuredClone(source)
    conditionData(multi).branchNodeList.multiArray[0].saveLen = [181, 182]
    conditionData(multi).branchNodeList.saveLen[0] = 2
    assert.throws(() => choose(graph, multi, [0]), code(ErrorCode.FunctionClosed))
    for (const id of [106001, 106003]) {
        const current = graphs.get(id),
            node = current.nodes.get(66),
            reachable = new Set(),
            queue = [current.start]
        while (queue.length) {
            const next = queue.shift()
            if (reachable.has(next)) continue
            reachable.add(next)
            queue.push(...asList(current.nodes.get(next)?.nextNodeIdList))
        }
        assert(!reachable.has(66), 'No declared edge from the current start reaches this empty-exit metadata')
        assert(conditionData(node).branchNodeList.saveLen.every((size) => size === 0))
        assert.throws(() => choose(current, node, [0]), code(ErrorCode.FunctionClosed))
    }
})

function fixture(step) {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:')
    const game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 }),
        graph = graphs.get(106010)
    let session = {},
        sequence = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, request) })
            .map((packet) => ({
                id: packet.id,
                name: protocol.byId.get(packet.id).name,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'branch-current-' + step })
    }
    login()
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.world.map_id = 100
        s.taskEpochs ??= {}
        s.taskEpochs[106010] = 1
        s.tasks = [
            {
                task_id: 106010,
                start_time: 1800000000,
                nodes: [makeNode(graph, 151, s)],
                finish_nodes: [3, 74, 78, 149, 82],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        s.taskRecords = (s.taskRecords ?? []).filter((row) => row.task_id !== 106010)
    })
    const task = () => state().tasks.find((row) => row.task_id === 106010)
    const syncNode = (packets, id) =>
        packets
            .filter((packet) => packet.name === 'CSProtoTaskSync')
            .flatMap((packet) => packet.data.tasks ?? [])
            .find((task) => task.task_id === 106010 && task.nodes.some((node) => node.node_id === id))
            ?.nodes.find((node) => node.node_id === id)
    const restorePhase = (wire) =>
        edit((s) => {
            const task = s.tasks.find((row) => row.task_id === 106010)
            task.finish_nodes = task.finish_nodes.filter((id) => id !== 148)
            task.nodes = [{ ...makeNode(graph, 148, s), ...(wire ? structuredClone(wire) : {}) }]
        })
    return { protocol, store, graph, call, login, edit, state, task, syncNode, restorePhase }
}

for (const [step, group, successor] of [
    [1, 1, 181],
    [2, 4, 182],
    [3, 7, 183],
])
    test(`real106010 choice${step} produces group${group}; normal fast path and acknowledged148 replay select only${successor}`, () => {
        const f = fixture(step),
            request = { task_id: 106010, node_id: 148 }
        try {
            f.call('TaskClientBefore', { task_id: 106010, node_id: 151 })
            f.call('PlayableStart', { u32: 60001 })
            const beforePets = f.state().pets.length
            f.call('PlayableStep', { playId: 60001, is_step: true, finish_step: step })
            assert.equal(f.state().pets.length, beforePets + 1)
            assert.equal(f.state().taskPetChoices[106010], group)
            f.call('PlayableStep', { playId: 60001, is_step: true, finish_step: step })
            assert.equal(f.state().pets.length, beforePets + 1)
            f.call('PlayableStep', { playId: 60001, is_step: true, finish_step: 10 })
            f.call('PlayableFinish', { playId: 60001, score: 0, pos: {} })
            assert.equal(f.state().playableFinishes[60001].selected_pet_group, group)
            f.call('TaskClientCondAfter', { task_id: 106010, node_id: 151, indexes: [0] })
            f.call('TaskClientAfter', { task_id: 106010, node_id: 151 })
            // Existing fast path already crosses148 in a normal run. Keep it intact.
            assert(f.task().finish_nodes.includes(148))
            assert.deepEqual(
                f.task().nodes.map((node) => node.node_id),
                [successor],
            )
            assert.equal(f.state().pets.length, beforePets + 1)

            // Controlled in-flight callback recovery. Keep the real selected-pet
            // receipt/assets and151 completion; re-enter only the148 callback phase.
            f.restorePhase()
            const beforePacket = f.call('TaskClientBefore', request),
                beforeWire = f.syncNode(beforePacket, 148)
            assert(beforeWire?.client_before)
            f.restorePhase(beforeWire)
            const bad = structuredClone(f.state())
            assert.throws(
                () => f.call('TaskClientCondAfter', { ...request, indexes: [3] }),
                code(ErrorCode.InvalidArgument),
            )
            assert.deepEqual(f.state(), bad)
            assert.throws(
                () => f.call('TaskClientCondAfter', { ...request, indexes: [step % 3] }),
                code(ErrorCode.InvalidArgument),
            )
            assert.deepEqual(f.state(), bad)
            const ack = f.call('TaskClientCondAfter', { ...request, indexes: [step - 1] }),
                ackWire = f.syncNode(ack, 148)
            assert.equal(ackWire?.client_cond_after[step - 1], true)
            f.restorePhase(ackWire)
            const snapshot = structuredClone(f.state()),
                encode = f.protocol.encode
            f.protocol.encode = function (name, value) {
                if (name === f.protocol.byName.get('CSProtoTaskSync').rsp) throw Error('current-branch-codec')
                return encode.call(this, name, value)
            }
            try {
                assert.throws(() => f.call('TaskClientAfter', request), /current-branch-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), snapshot)
            const packets = f.call('TaskClientAfter', request)
            const key = deliveryKey(f.state(), 106010, 148, 'branch')
            assert.deepEqual(f.state().taskBranchChoices[key], { indexes: [step - 1], next: [successor] })
            assert(f.syncNode(packets, successor))
            const completed = structuredClone(f.state().taskBranchChoices[key]),
                count = f.state().pets.length
            f.call('TaskClientAfter', request)
            assert.deepEqual(f.state().taskBranchChoices[key], completed)
            assert.equal(f.state().pets.length, count)
            f.login()
            assert.deepEqual(f.state().taskBranchChoices[key], completed)
            assert.deepEqual(
                f.task().nodes.map((node) => node.node_id),
                [successor],
            )
        } finally {
            f.store.close()
        }
    })
