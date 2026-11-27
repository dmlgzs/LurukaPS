import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'next-day' })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 16
        s.world.map_id = 200
        s.taskEpochs[106015] = 1
        s.tasks = [
            {
                task_id: 106015,
                nodes: [{ ...makeNode(new TaskGraphs(tables).get(106015), 17, s), client_before: true }],
                finish_nodes: [1, 71, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 43, 73, 23, 62, 68, 67, 69, 15],
                reward_nodes: [],
                client_trace: true,
                start_time: 1790710275,
            },
        ]
        s.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1 && r.id !== 106015)
            .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        s.clientBehaviour = []
    })
    return { store, session, call, state: () => store.load(session.id).state }
}
test('legacy hour-only1100 remains compatible and advances via ordinary task acknowledgments', () => {
    const f = fixture()
    try {
        for (const time of [2300, 800, 1002]) f.call('WorldTimeSync', { world_time: time })
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        const q = { task_id: 106015, node_id: 17 }
        assert.throws(() => f.call('TaskClientCondAfter', { ...q, indexes: [0] }), /not complete/)
        const packets = f.call('ClientBehaviourRecord', { key: 1100, args: [8, 1] })
        assert.ok(packets.some((p) => p.id === 9853))
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
        assert.equal(f.state().tasks[0].nodes[0].node_id, 17)
        assert.ok(!f.state().clientBehaviour.some((r) => r.key === 1100))
        const before = f.state()
        f.call('ClientBehaviourRecord', { key: 1100, args: [8, 1] })
        assert.deepEqual(f.state(), before)
        f.call('TaskClientCondAfter', { ...q, indexes: [0] })
        f.call('TaskClientAfter', q)
        assert.equal(f.state().tasks[0].nodes[0].node_id, 18)
        f.call('ClientBehaviourRecord', { key: 1100, args: [8, 1] })
        assert.equal(f.state().tasks[0].nodes[0].node_id, 18)
    } finally {
        f.store.close()
    }
})
test('time reports reject invalid count/hour and an out-of-range daytime without modifying progress', () => {
    const f = fixture()
    try {
        for (const args of [
            [5, 1],
            [18, 1],
            [24, 1],
            [8, 2],
            [8, 1, 1],
        ]) {
            const before = f.state()
            assert.throws(() => f.call('ClientBehaviourRecord', { key: 1100, args }))
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('login restores the already-received1100 event from the old generic cache without another clock change', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.clientBehaviour.push({ key: 1100, args: [8, 1], time: 1790781162 })
        })
        const before = f.state().world.world_time
        const packets = f.call('EnterGame', { open_id: 'next-day', reconnect: true }, {})
        const task = protocol
            .decode('SCTaskSync', packets.find((p) => p.id === 9853).payload)
            .tasks.find((t) => t.task_id === 106015)
        assert.equal(task.nodes[0].node_values[0], 1)
        assert.equal(f.state().world.world_time, before)
        const receipt = f.state().taskTimeReports['106015:1:17:0']
        f.call('EnterGame', { open_id: 'next-day', reconnect: true }, {})
        assert.deepEqual(f.state().taskTimeReports['106015:1:17:0'], receipt)
    } finally {
        f.store.close()
    }
})
test('cached time reports from before the task epoch are not credited', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.clientBehaviour.push({ key: 1100, args: [8, 1], time: 1790000000 })
        })
        f.call('EnterGame', { open_id: 'next-day', reconnect: true }, {})
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
    } finally {
        f.store.close()
    }
})
