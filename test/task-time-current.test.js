import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables),
    graphs = new TaskGraphs(tables)

// Explicit node-entry qualification, not a natural account progression test.
// Prerequisite task identities/levels and node ancestry come from current data.
function fixture(account, { second = false } = {}) {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:')
    const main = graphs.get(106015),
        side = graphs.get(208007)
    const previous = new Set(),
        levels = []
    const visit = (id) => {
        for (const part of String(tables.find('task', id).unlockcondition).split('|')) {
            const [kind, value] = part.split('#').map(Number)
            if (kind === 2004) levels.push(value)
            if (kind === 2007 && !previous.has(value)) {
                previous.add(value)
                visit(value)
            }
        }
    }
    visit(106015)
    if (second) visit(208007)
    const ancestor = (graph, target) => {
        const seen = new Set()
        const back = (id) => {
            if (id === graph.start) return
            for (const parent of graph.nodes.get(id).prevNodeIdList ?? []) {
                assert(graph.nodes.has(parent))
                if (!seen.has(parent)) {
                    seen.add(parent)
                    back(parent)
                }
            }
        }
        back(target)
        return [...seen]
    }
    store.login(account, (id, openId) => {
        const state = seedPlayer(tables, id, openId)
        state.player.basic_info.lv = Math.max(...levels)
        state.taskRecords = [...previous].map((task_id) => ({ task_id, count: 1, time: 1799999999 }))
        Object.assign(state.world, tables.position(tables.find('world_borthpos', 70101)))
        state.taskEpochs = { 106015: 1, ...(second ? { 208007: 1 } : {}) }
        state.tasks = [
            {
                task_id: 106015,
                nodes: [makeNode(main, 17, state)],
                finish_nodes: ancestor(main, 17),
                reward_nodes: [],
                client_trace: true,
                start_time: 1800000000,
            },
            ...(second
                ? [
                      {
                          task_id: 208007,
                          nodes: [makeNode(side, 76, state)],
                          finish_nodes: ancestor(side, 76),
                          reward_nodes: [],
                          client_trace: true,
                      },
                  ]
                : []),
        ]
        return state
    })
    let game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {},
        seq = 1
    const call = (name, value = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: row.id,
            seq: seq++,
            payload: row.req ? protocol.encode(row.req, value) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: account })
    return {
        protocol,
        store,
        call,
        state,
        edit: (change) => store.transact(session.id, 0, change),
        reload() {
            game = new Game(protocol, store, tables, { clock: () => 1800000000 })
            session = {}
            call('EnterGame', { open_id: account, reconnect: true })
        },
    }
}

test('current scoped1100 payload completes its acknowledged time condition without an invented hour or world clock', () => {
    const f = fixture('current-time-scoped')
    try {
        const request = { key: 1100, args: [106015, 17, 0, 1] }
        assert.throws(() => f.call('ClientBehaviourRecord', request))
        f.call('TaskClientBefore', { task_id: 106015, node_id: 17 })
        const originalTime = f.state().world.world_time
        f.call('WorldTimeSync', { world_time: 800 })
        assert.equal(f.state().tasks.find((t) => t.task_id === 106015).nodes[0].node_values[0], 0)
        const packets = f.call('ClientBehaviourRecord', request)
        assert(packets.some((packet) => packet.id === 9853))
        const key = '106015:1:17:0',
            receipt = f.state().taskTimeReports[key]
        assert.equal(receipt.format, 'indexed')
        assert.equal('hour' in receipt, false)
        assert.equal(f.state().tasks.find((t) => t.task_id === 106015).nodes[0].node_values[0], 1)
        const before = f.state()
        f.call('ClientBehaviourRecord', request)
        assert.deepEqual(f.state(), before)
        f.call('TaskClientCondAfter', { task_id: 106015, node_id: 17, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 106015, node_id: 17 })
        assert.equal(f.state().tasks.find((t) => t.task_id === 106015).nodes[0].node_id, 18)
        const after = f.state()
        f.call('ClientBehaviourRecord', request)
        assert.deepEqual(f.state(), after)
        f.reload()
        assert.deepEqual(f.state().taskTimeReports[key], receipt)
        assert.equal(f.state().world.world_time, 800)
        assert.notEqual(originalTime, 800)
    } finally {
        f.store.close()
    }
})

test('current task/node/index report chooses exactly one of two qualified active timers', () => {
    const f = fixture('current-time-two', { second: true })
    try {
        for (const [task_id, node_id] of [
            [106015, 17],
            [208007, 76],
        ])
            f.call('TaskClientBefore', { task_id, node_id })
        f.call('ClientBehaviourRecord', { key: 1100, args: [106015, 17, 0, 1] })
        assert.equal(f.state().tasks.find((t) => t.task_id === 106015).nodes[0].node_values[0], 1)
        assert.equal(f.state().tasks.find((t) => t.task_id === 208007).nodes[0].node_values[0], 0)
        f.call('ClientBehaviourRecord', { key: 1100, args: [208007, 76, 0, 1] })
        assert.equal(f.state().tasks.find((t) => t.task_id === 208007).nodes[0].node_values[0], 1)
    } finally {
        f.store.close()
    }
})

test('scoped time reports reject malformed scope,type,index and count with an unchanged Store transaction', () => {
    const f = fixture('current-time-bad')
    try {
        f.call('TaskClientBefore', { task_id: 106015, node_id: 17 })
        for (const [args, code] of [
            [[106015, 17, 0, 0], ErrorCode.InvalidArgument],
            [[106015, 17, 0, 2], ErrorCode.InvalidArgument],
            [[999999, 17, 0, 1], ErrorCode.PlayerTaskNotFound],
            [[106015, 999, 0, 1], ErrorCode.TaskNoNodeId],
            [[106015, 17, 99, 1], ErrorCode.TaskNodeIndexLimit],
            [[106015, 71, 0, 1], ErrorCode.InvalidArgument],
            [[8, 106015, 17, 0, 1], ErrorCode.InvalidArgument],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('ClientBehaviourRecord', { key: 1100, args }),
                (error) => error.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('failed scoped time response encoding rolls back the exact completion receipt and remains retryable', () => {
    const f = fixture('current-time-codec')
    try {
        f.call('TaskClientBefore', { task_id: 106015, node_id: 17 })
        const before = f.state(),
            original = f.protocol.encode.bind(f.protocol),
            sync = f.protocol.byId.get(9853).rsp
        f.protocol.encode = (type, value) => {
            if (
                type === sync &&
                value.tasks?.some(
                    (task) =>
                        task.task_id === 106015 &&
                        task.nodes?.some((node) => node.node_id === 17 && node.node_values?.[0] === 1),
                )
            )
                throw Error('time-sync-codec-failure')
            return original(type, value)
        }
        assert.throws(
            () => f.call('ClientBehaviourRecord', { key: 1100, args: [106015, 17, 0, 1] }),
            /time-sync-codec-failure/,
        )
        assert.deepEqual(f.state(), before)
        f.protocol.encode = original
        f.call('ClientBehaviourRecord', { key: 1100, args: [106015, 17, 0, 1] })
        assert.equal(f.state().taskEvents['106015:1:17:0'], 1)
    } finally {
        f.store.close()
    }
})

test('legacy generic cache recovery never promotes a scoped packet as a guessed hour report', () => {
    const f = fixture('current-time-cache-scope')
    try {
        f.call('TaskClientBefore', { task_id: 106015, node_id: 17 })
        f.edit((state) => {
            state.clientBehaviour ??= []
            state.clientBehaviour.push({ key: 1100, args: [106015, 17, 0, 1], time: 1800000000 })
        })
        f.reload()
        assert.equal(f.state().tasks.find((t) => t.task_id === 106015).nodes[0].node_values[0], 0)
        assert.equal(f.state().taskTimeReports?.['106015:1:17:0'], undefined)
    } finally {
        f.store.close()
    }
})
