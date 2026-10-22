import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { taskBranchExit } from '../src/task-branch-flow.js'
import { ErrorCode } from '../src/error-codes.js'
const conf = configuration(),
    tables = new Tables(conf.tables),
    protocol = new Protocol(conf.base)
function setup({ rewardFixture = false } = {}) {
    const source = rewardFixture
        ? Object.assign(Object.create(tables), {
              get: (name) =>
                  name === 'task_step'
                      ? [...tables.get(name), { id: 0, taskId: 100001, nodeId: 26, reward: 18002 }]
                      : tables.get(name),
          })
        : tables
    const store = new Store(':memory:'),
        game = new Game(protocol, store, source),
        graph = new TaskGraphs(source).get(100001)
    let session = {},
        seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'branch-task' })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.world.map_id = 200
        s.taskEpochs = { 100001: 1 }
        s.tasks = [
            {
                task_id: 100001,
                start_time: 1,
                nodes: [{ ...makeNode(graph, 26, s), client_before: true }],
                finish_nodes: [19],
                reward_nodes: [],
            },
        ]
        s.storyWatches = { 'fixture:202807:1': { story_id: 202807, tag: 1 } }
    })
    return { store, call, edit, login, state: () => store.load(session.id).state }
}
const request = { task_id: 100001, node_id: 26 }
test('9862 actual branch100001/26 requires a true server condition and CondAfter ACK, then selects only the matching exit', () => {
    const f = setup()
    try {
        let before = f.state()
        assert.throws(() => f.call('TaskClientAfter', request), /acknowledged branch/)
        assert.deepEqual(f.state(), before)
        assert.throws(() => f.call('TaskClientCondAfter', { ...request, indexes: [0] }), /Server task condition/)
        assert.deepEqual(f.state(), before)
        f.call('TaskClientCondAfter', { ...request, indexes: [1] })
        const packets = f.call('TaskClientAfter', request),
            state = f.state(),
            task = state.tasks.find((t) => t.task_id === 100001)
        assert.deepEqual(
            task.nodes.map((n) => n.node_id),
            [23],
        )
        assert.ok(task.finish_nodes.includes(26))
        assert.deepEqual(state.taskBranchChoices['100001:1:26:branch'], { indexes: [1], next: [23] })
        let sync = packets.find((p) => p.id === protocol.byName.get('CSProtoTaskSync').id)
        assert.ok(sync)
        let decoded = protocol.decode('SCTaskSync', sync.payload).tasks.find((t) => t.task_id === 100001)
        assert.deepEqual(
            decoded.nodes.map((n) => n.node_id),
            [23],
        )
        f.call('TaskClientAfter', request)
        assert.deepEqual(
            f
                .state()
                .tasks.find((t) => t.task_id === 100001)
                .nodes.map((n) => n.node_id),
            [23],
        )
        f.login()
        assert.deepEqual(f.state().taskBranchChoices['100001:1:26:branch'], {
            indexes: [1],
            next: [23],
        })
    } finally {
        f.store.close()
    }
})
test('two true acknowledged conditions with different exits remain blocked instead of guessing or opening every branch', () => {
    const f = setup()
    try {
        f.edit((s) => (s.storyWatches.second = { story_id: 202807, tag: 0 }))
        f.call('TaskClientCondAfter', { ...request, indexes: [0, 1] })
        const before = f.state()
        assert.throws(
            () => f.call('TaskClientAfter', request),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('current duplicate-target branch400101/6 collapses multiple confirmed indexes to one successor', () => {
    const graph = new TaskGraphs(tables).get(400101),
        config = graph.nodes.get(6)
    assert.deepEqual(taskBranchExit(graph, config, { client_cond_after: [true, true] }, [1, 1], [1, 1]), {
        indexes: [0, 1],
        next: [5],
    })
})
test('all current resolvable branch shapes retain exact ordered flat exits; absent mappings remain unsupported', () => {
    const folder = path.resolve(tables.dir, '../Config/Task')
    let supported = 0,
        missing = 0
    for (const name of fs.readdirSync(folder).filter((n) => /^task_client_\d+\.json$/.test(n))) {
        const raw = JSON.parse(fs.readFileSync(path.join(folder, name))),
            nodes = new Map(
                [].concat(raw.nodes ?? []).map((n) => [n.__type_TaskBaseNodeData.id, n.__type_TaskBaseNodeData]),
            )
        for (const config of nodes.values())
            if (config.nodeType === 34) {
                const conditions = [].concat(config.__type_TaskConditonBranchNodeData.conditionList),
                    next = [].concat(config.nextNodeIdList ?? []),
                    graph = { nodes }
                if (!next.length) {
                    missing++
                    assert.throws(
                        () =>
                            taskBranchExit(
                                graph,
                                config,
                                { client_cond_after: conditions.map(() => true) },
                                conditions.map(() => 1),
                                conditions.map(() => 1),
                            ),
                        (e) => e.code === ErrorCode.FunctionClosed,
                    )
                    continue
                }
                supported++
                for (let index = 0; index < conditions.length; index++) {
                    const flags = conditions.map((_, i) => i === index),
                        values = conditions.map((_, i) => (i === index ? 1 : 0))
                    assert.deepEqual(
                        taskBranchExit(
                            graph,
                            config,
                            { client_cond_after: flags },
                            values,
                            conditions.map(() => 1),
                        ).next,
                        [next[index]],
                    )
                }
            }
    }
    assert.equal(supported, 11)
    assert.equal(missing, 5)
})
test('nonempty MultiList, mismatched condition indexing and stale server values cannot manufacture an exit', () => {
    const graph = new TaskGraphs(tables).get(100001),
        source = graph.nodes.get(26)
    for (const mutate of [
        (n) => (n.__type_TaskConditonBranchNodeData.branchNodeList.field_520102 = [1, 0]),
        (n) => (n.__type_TaskConditonBranchNodeData.conditionList[0].index = 7),
        (n) => (n.nextNodeIdList = [22]),
    ]) {
        const config = structuredClone(source)
        mutate(config)
        assert.throws(() => taskBranchExit(graph, config, { client_cond_after: [true, false] }, [1, 0], [1, 1]))
    }
    assert.throws(
        () => taskBranchExit(graph, source, { client_cond_after: [false, true] }, [0, 0], [1, 1]),
        /server-validated/,
    )
    assert.throws(
        () => taskBranchExit(graph, source, { client_cond_after: [false, false] }, [1, 0], [1, 1]),
        /acknowledged/,
    )
})
test('fixture reward on the real branch uses normal once-only delivery and is not repeated after retry or relogin', () => {
    const f = setup({ rewardFixture: true })
    try {
        f.call('TaskClientCondAfter', { ...request, indexes: [1] })
        const before = f.state().player.basic_info.gold
        f.call('TaskClientAfter', request)
        assert.equal(f.state().player.basic_info.gold, before + 100)
        f.call('TaskClientAfter', request)
        assert.equal(f.state().player.basic_info.gold, before + 100)
        f.login()
        f.call('TaskClientAfter', request)
        assert.equal(f.state().player.basic_info.gold, before + 100)
    } finally {
        f.store.close()
    }
})
test('failed branch sync encoding rolls back successor, rewards and branch receipt', () => {
    const f = setup({ rewardFixture: true })
    try {
        f.call('TaskClientCondAfter', { ...request, indexes: [1] })
        const before = f.state(),
            old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('CSProtoTaskSync').rsp) throw Error('branch codec rollback')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.call('TaskClientAfter', request), /branch codec rollback/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
