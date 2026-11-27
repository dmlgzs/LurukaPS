import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, taskSnapshot } from '../src/tasks.js'
import { suspendUnavailableTasks, unavailableTaskNodeIds, suspendedTaskIds } from '../src/task-compatibility.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    graphs = new TaskGraphs(tables)
const oldTask = () => ({
    task_id: 206022,
    nodes: [{ node_id: 3, node_values: [0], client_before: false, client_cond_after: [false] }],
    finish_nodes: [1],
    reward_nodes: [],
    client_trace: true,
    start_time: 1700000000,
})
const normalTask = () => ({
    task_id: 106001,
    nodes: [{ node_id: 5, node_values: [0], client_before: false, client_cond_after: [false] }],
    finish_nodes: [1],
    reward_nodes: [],
    client_trace: true,
    start_time: 1700000000,
})
function legacyState(name = 'task-graph-compat') {
    const s = seedPlayer(tables, 1, name)
    delete s.starterProfile
    delete s.normalStarterAvatar
    s.characterCustomized = true
    s.player.basic_info.lock_system = []
    s.tasks = [normalTask(), oldTask()]
    s.taskEpochs = { 106001: 4, 206022: 1 }
    s.taskRecords = [{ task_id: 996002, count: 1, time: 1699999999 }]
    s.taskFinishReceipts = { '996002:1': { historical: true } }
    s.taskDeliveries = { '206022:1:3:0': { original: true } }
    s.taskTraceChoices = { '206022:1': true, '106001:4': true }
    return s
}
const exact = (v) => JSON.stringify(v)
function fixture({ file = ':memory:', codec = false } = {}) {
    const name = 'current-task-graph-' + ++fixture.counter,
        original = legacyState(name)
    let store = new Store(file),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 }),
        seq = 1
    const account = store.login(name, () => structuredClone(original))
    const call = (name, value = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        assert(e)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, value) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(account.id).state
    const sql = () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(account.id)
    return {
        name,
        original,
        account,
        call,
        state,
        sql,
        get store() {
            return store
        },
        get game() {
            return game
        },
        get session() {
            return session
        },
        reopen() {
            store.close()
            store = new Store(file)
            game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 })
            session = {}
        },
        close() {
            store.close()
        },
    }
}
fixture.counter = 0
function archive(s) {
    return s.compatibilityDiagnostics.suspendedTasks['206022:1']
}
function assertCurrentPackets(packets) {
    const e = protocol.byName.get('CSProtoTaskSync')
    for (const p of packets.filter((p) => p.id === e.id)) {
        const r = protocol.decode(e.rsp, p.payload)
        for (const t of r.tasks ?? []) {
            const g = graphs.get(t.task_id)
            for (const n of t.nodes) assert(g.nodes.has(n.node_id))
            for (const id of [...t.finish_nodes, ...t.reward_nodes]) assert(g.nodes.has(id))
        }
    }
}

test('current loaded graph isolates explicit unavailable references; empty and unreachable existing nodes stay intact and malformed IDs reject', () => {
    const g = graphs.get(206022),
        s = legacyState(),
        raw = structuredClone(s)
    assert(!g.nodes.has(3))
    assert.equal(tables.find('task', 206022).unlockcondition, '2007#102015')
    assert.deepEqual(unavailableTaskNodeIds(g, s.tasks[1]), [3])
    const empty = { ...oldTask(), nodes: [], finish_nodes: [], reward_nodes: [] }
    assert.deepEqual(unavailableTaskNodeIds(g, empty), [])
    // Explicit local graph-contract unit vector: an existing disconnected node
    // must not be interpreted as a version failure merely by DFS reachability.
    const disconnected = { ...g, nodes: new Map(g.nodes) }
    disconnected.nodes.set(90000001, { id: 90000001, nodeType: 30, nextNodeIdList: [] })
    assert.deepEqual(unavailableTaskNodeIds(disconnected, { ...empty, nodes: [{ node_id: 90000001 }] }), [])
    for (const bad of [0, -1, 1.5, '3', null, undefined, 0x100000000])
        assert.throws(
            () => unavailableTaskNodeIds(g, { ...empty, nodes: [{ node_id: bad }] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    assert.deepEqual(unavailableTaskNodeIds(g, { ...empty, finish_nodes: [3] }), [3])
    assert.deepEqual(unavailableTaskNodeIds(g, { ...empty, reward_nodes: [3] }), [3])
    assert.deepEqual(suspendUnavailableTasks(tables, s, graphs), [206022])
    assert.deepEqual(s.tasks, [raw.tasks[0]])
    assert.deepEqual(archive(s).task, raw.tasks[1])
    assert.equal(archive(s).reason, 'unavailableCurrentTaskNode')
    assert.equal(archive(s).nodeSource, 'unidentified-persistent-reference')
    assert.deepEqual(s.taskRecords, raw.taskRecords)
    assert.deepEqual(s.taskEpochs, raw.taskEpochs)
    assert.deepEqual(s.taskDeliveries, raw.taskDeliveries)
    assert.deepEqual(s.taskFinishReceipts, raw.taskFinishReceipts)
    for (const damaged of [null, false, { task: { task_id: 206022, nodes: [] } }]) {
        const broken = legacyState()
        broken.compatibilityDiagnostics = { suspendedTasks: { '206022:1': damaged } }
        const before = exact(broken)
        assert.throws(
            () => suspendUnavailableTasks(tables, broken, graphs),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.equal(exact(broken), before)
    }
    const done = exact(s)
    assert.deepEqual(suspendUnavailableTasks(tables, s, graphs), [])
    assert.equal(exact(s), done)
})

test('current graph read and structural failures propagate before any task/archive mutation; wrong package is not relabelled as an unavailable node', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-graph-config-'))
    try {
        const good = path.join(path.dirname(tables.dir), 'Config/Task/ast_task_client_106001.json')
        fs.copyFileSync(good, path.join(temp, 'ast_task_client_106001.json'))
        const cases = [
            { text: undefined, code: ErrorCode.TaskConfFail },
            { text: '{', name: 'SyntaxError' },
            { text: JSON.stringify({ taskId: 206022, nodes: [], endNodeId: 1 }), code: ErrorCode.GameConfig },
        ]
        for (const c of cases) {
            const target = path.join(temp, 'ast_task_client_206022.json')
            if (fs.existsSync(target)) fs.unlinkSync(target)
            if (c.text !== undefined) fs.writeFileSync(target, c.text)
            const s = legacyState()
            // First current graph classifies an unidentified positive saved
            // reference; a later graph error must still leave both untouched.
            s.tasks[0].nodes[0].node_id = 90000002
            const raw = exact(s)
            assert.throws(
                () => suspendUnavailableTasks(tables, s, new TaskGraphs(tables, temp)),
                (e) => (c.code ? e.code === c.code : e.name === c.name),
            )
            assert.equal(exact(s), raw)
        }
        const wrapper = Object.create(tables)
        wrapper.find = (n, id) =>
            n === 'task' && id === 206022 ? { ...tables.find(n, id), isReviewMode_tishen: 2 } : tables.find(n, id)
        const s = legacyState(),
            raw = exact(s)
        assert.deepEqual(
            suspendUnavailableTasks(wrapper, s, {
                get(id) {
                    assert.notEqual(id, 206022)
                    return graphs.get(id)
                },
            }),
            [],
        )
        assert.equal(exact(s), raw)
    } finally {
        fs.rmSync(temp, { recursive: true, force: true })
    }
})

test('only instance-owned pending references and foreign story hints are archived; trace and earned ledgers remain intact', () => {
    const s = legacyState()
    s.pendingTaskScene = { task_id: 206022, node_id: 3, point_id: 10108, map_id: 101 }
    s.pendingCharacterTask = { task_id: 206022, node_id: 3, epoch: 2, otherInstance: true }
    s.pendingTaskStorySync = {
        task_id: 106001,
        node_id: 5,
        stories: [100601],
        extra: { new_task_ids: [106001, 206022], other: 'keep' },
    }
    const raw = structuredClone(s)
    suspendUnavailableTasks(tables, s, graphs)
    assert.deepEqual(archive(s).pendingTaskScene, raw.pendingTaskScene)
    assert.equal(s.pendingTaskScene, undefined)
    assert.deepEqual(s.pendingCharacterTask, raw.pendingCharacterTask)
    assert.equal(archive(s).pendingCharacterTask, undefined)
    assert.deepEqual(s.pendingTaskStorySync, {
        ...raw.pendingTaskStorySync,
        extra: { ...raw.pendingTaskStorySync.extra, new_task_ids: [106001] },
    })
    assert.deepEqual(archive(s).pendingStoryHint.rawTaskIds, [106001, 206022])
    assert.equal(archive(s).traceChoice, true)
    for (const field of ['taskEpochs', 'taskTraceChoices', 'taskRecords', 'taskFinishReceipts', 'taskDeliveries'])
        assert.deepEqual(s[field], raw[field])
    const owned = legacyState()
    owned.pendingTaskStorySync = { task_id: 206022, node_id: 3, extra: { new_task_ids: [206022] } }
    owned.pendingCharacterTask = { task_id: 206022, node_id: 3, epoch: 1 }
    const before = structuredClone(owned)
    suspendUnavailableTasks(tables, owned, graphs)
    assert.deepEqual(archive(owned).pendingTaskStorySync, before.pendingTaskStorySync)
    assert.deepEqual(archive(owned).pendingCharacterTask, before.pendingCharacterTask)
    assert.equal(owned.pendingTaskStorySync, undefined)
    assert.equal(owned.pendingCharacterTask, undefined)
})

test('real default Game login→Loaded→idle→SQLite cold reopen preserves complete old instance and emits current graph references only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-task-graph-cold-')),
        f = fixture({ file: path.join(dir, 'synthetic.sqlite') })
    try {
        const raw = structuredClone(f.original.tasks[1]),
            hist = structuredClone(f.original.taskRecords)
        assertCurrentPackets(f.call('EnterGame', { open_id: f.name }))
        assert.deepEqual(archive(f.state()).task, raw)
        assert(!f.state().tasks.some((t) => t.task_id === 206022))
        assert(f.state().tasks.some((t) => t.task_id === 106001 && t.nodes.some((n) => n.node_id === 5)))
        assertCurrentPackets(f.call('MultiCampaignPlayerLoaded'))
        assertCurrentPackets(f.game.tick(f.account.id, f.session))
        const saved = structuredClone(archive(f.state()))
        assert.deepEqual(f.state().taskRecords, hist)
        f.reopen()
        assertCurrentPackets(f.call('EnterGame', { open_id: f.name, reconnect: true }))
        assert.deepEqual(archive(f.state()), saved)
        assert.deepEqual(f.state().taskRecords, hist)
        assert.deepEqual(f.state().taskEpochs, { 106001: 4, 206022: 1 })
        assert.deepEqual(f.state().taskFinishReceipts, f.original.taskFinishReceipts)
        assert.deepEqual(f.state().taskDeliveries, f.original.taskDeliveries)
    } finally {
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('actual codec and SQLite failures roll back the full tuple; retry never duplicates archive and a bad RPC never archives player tasks', () => {
    for (const mode of ['codec', 'sql']) {
        const f = fixture()
        try {
            const raw = exact(f.store.load(f.account.id)),
                sql = exact(f.sql()),
                encode = protocol.encode
            if (mode === 'codec')
                protocol.encode = function (type, value) {
                    if (type === protocol.byName.get('CSProtoEnterGame').rsp)
                        throw new Error('taskGraph codec boundary')
                    return encode.call(this, type, value)
                }
            else
                f.store.db.exec(
                    "CREATE TRIGGER fail_task_graph BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'taskGraph SQL boundary'); END",
                )
            try {
                assert.throws(() => f.call('EnterGame', { open_id: f.name }), /taskGraph (codec|SQL) boundary/)
            } finally {
                protocol.encode = encode
                if (mode === 'sql') f.store.db.exec('DROP TRIGGER fail_task_graph')
            }
            assert.equal(exact(f.store.load(f.account.id)), raw)
            assert.equal(exact(f.sql()), sql)
            f.call('EnterGame', { open_id: f.name })
            assert.equal(Object.keys(f.state().compatibilityDiagnostics.suspendedTasks).length, 1)
            const before = exact(f.store.load(f.account.id)),
                archiveBefore = exact(archive(f.state()))
            assert.throws(
                () => f.call('TaskSubmitItem', { task_id: 206022, node_id: 3, node_index: 0, items: [] }),
                (e) => e.code === ErrorCode.TaskNoNodeId,
            )
            assert.equal(exact(f.store.load(f.account.id)), before)
            assert.equal(exact(archive(f.state())), archiveBefore)
        } finally {
            f.close()
        }
    }
})

test('old prerequisite cannot reopen the new version; real current story receipt plus trusted102015 checkpoint permits new epoch without self-deletion', () => {
    const f = fixture()
    try {
        f.call('EnterGame', { open_id: f.name })
        assert.throws(() => f.call('TaskAccept', { u32: 206022 }), /prerequisites not met/)
        assert.equal(f.state().taskEpochs[206022], 1)
        // Explicit trusted progressed-save checkpoint, not a synthetic TaskFinish/reward.
        // Current story receipt is then produced by the actual6060 handler.
        f.store.transact(f.account.id, 0, (s) => {
            s.taskRecords.push({ task_id: 102015, count: 1, time: 1799999999 })
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 101027)))
        })
        assert.throws(() => f.call('TaskAccept', { u32: 206022 }), /prerequisites not met/)
        f.call('SetStoryId', { story_id: 302301, story_type: 0, tag: 0, is_skip: false })
        const old = structuredClone(archive(f.state())),
            packets = f.call('TaskAccept', { u32: 206022 })
        assertCurrentPackets(packets)
        const task = f.state().tasks.find((t) => t.task_id === 206022)
        assert(task)
        assert.equal(f.state().taskEpochs[206022], 2)
        assert(task.nodes.every((n) => graphs.get(206022).nodes.has(n.node_id)))
        assert(!task.nodes.some((n) => n.node_id === 3))
        assert.deepEqual(archive(f.state()), old)
        assert(!suspendedTaskIds(f.state()).includes(206022))
        const sync = taskSnapshot(tables, f.state())
        assert(sync.tasks.some((t) => t.task_id === 206022))
        assert(!sync.del_tasks.includes(206022))
        assert(!sync.del_trace_list.includes(206022))
        assert(!f.state().taskRecords.some((t) => t.task_id === 206022))
        assert.deepEqual(f.state().taskFinishReceipts, f.original.taskFinishReceipts)
    } finally {
        f.close()
    }
})
