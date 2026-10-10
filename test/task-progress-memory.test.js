import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { deliveryKey } from '../src/task-delivery.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(taskId, nodeId, map) {
    const store = new Store(':memory:', { flushIntervalMs: 60000 }),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'task-memory' })
    store.transact(session.id, 0, (s) => {
        Object.assign(s.world, tables.position(tables.get('world_borthpos').find((p) => p.cityId === map)))
        const graph = new TaskGraphs(tables).get(taskId)
        s.tasks = [
            {
                task_id: taskId,
                nodes: [makeNode(graph, nodeId, s)],
                finish_nodes: [graph.start],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        s.taskRecords = tables
            .get('task')
            .filter((t) => t.type === 1 && t.id !== taskId)
            .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
    })
    const database = () => store.db.prepare('select state,revision from players where account_id=?').get(session.id)
    return {
        store,
        session,
        call,
        database,
        edit: (fn) => store.transact(session.id, 0, fn),
        state: () => store.load(session.id).state,
    }
}
test('Before/CondAfter/rewardless After batch into one save while replies and request diagnostics stay intact', () => {
    const f = fixture(106001, 57, 102)
    try {
        f.edit((s) => {
            s.taskEvents = { [deliveryKey(s, 106001, 57, 0)]: 1 }
        })
        const before = f.database(),
            logCount = f.store.db.prepare('select count(*) n from request_log').get().n
        const r = { task_id: 106001, node_id: 57 }
        f.call('TaskClientBefore', r)
        f.call('TaskClientCondAfter', { ...r, indexes: [0] })
        f.call('TaskClientAfter', r)
        assert.deepEqual(f.database(), before)
        assert.equal(f.state().tasks.find((t) => t.task_id === 106001).nodes[0].node_id, 65)
        assert.equal(f.store.db.prepare('select count(*) n from request_log').get().n, logCount)
        f.store.flushPending()
        assert.equal(f.database().revision, before.revision + 1)
        assert.equal(JSON.parse(f.database().state).tasks.find((t) => t.task_id === 106001).nodes[0].node_id, 65)
        assert.deepEqual(
            f.store.db
                .prepare('select message_id from request_log order by id desc limit 3')
                .all()
                .reverse()
                .map((r) => r.message_id),
            [9861, 9863, 9862],
        )
    } finally {
        f.store.close()
    }
})
test('actual hero reward immediately commits preceding metadata and once-only receipt in one transaction', () => {
    const f = fixture(106009, 10, 100)
    try {
        const before = f.database(),
            r = { task_id: 106009, node_id: 10 }
        f.call('TaskClientBefore', r)
        f.call('TaskClientCondAfter', { ...r, indexes: [0] })
        assert.deepEqual(f.database(), before)
        f.call('TaskClientAfter', r)
        assert.equal(f.database().revision, before.revision + 1)
        assert.ok(JSON.parse(f.database().state).player.heros_info.heros.some((h) => h.conf_id === 108001))
        const committed = f.database()
        f.call('TaskClientAfter', r)
        assert.deepEqual(f.database(), committed, 'reward retry must not commit another delivery')
    } finally {
        f.store.close()
    }
})
test('configured task-item creation remains immediately durable without a loot reward', () => {
    const f = fixture(106015, 30, 100)
    try {
        f.edit((s) => {
            s.taskDeliveries = { [deliveryKey(s, 106015, 30, 0)]: { '3:306002': 1, '3:306003': 1, '3:306000': 1 } }
        })
        const before = f.database(),
            r = { task_id: 106015, node_id: 30 }
        f.call('TaskClientBefore', r)
        f.call('TaskClientCondAfter', { ...r, indexes: [0] })
        f.call('TaskClientAfter', r)
        assert.equal(f.database().revision, before.revision + 1)
        assert.equal(JSON.parse(f.database().state).taskItems.find((i) => i.item_id === 450125).item_num, 1)
    } finally {
        f.store.close()
    }
})
test('failed deferred condition update rolls back its draft while retaining previously accepted metadata', () => {
    const f = fixture(106001, 57, 102)
    try {
        f.call('TaskClientBefore', { task_id: 106001, node_id: 57 })
        const before = f.state()
        assert.throws(
            () => f.call('TaskClientCondAfter', { task_id: 106001, node_id: 57, indexes: [99] }),
            /Invalid task condition indexes/,
        )
        assert.deepEqual(f.state(), before)
        f.store.flushPending()
        assert.equal(
            JSON.parse(f.database().state).tasks.find((t) => t.task_id === 106001).nodes[0].client_before,
            true,
        )
    } finally {
        f.store.close()
    }
})
