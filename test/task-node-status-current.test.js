import test from 'node:test'
import assert from 'node:assert/strict'
import { taskNodeFinishedCurrentAttempt } from '../src/task-node-status.js'
import { taskNodeCompleted, taskUnlocked } from '../src/tasks.js'
import { homeCondition } from '../src/home-grid.js'
import { ActivityCatalog } from '../src/activities.js'
import { activityConditionUnlocked } from '../src/activity-access.js'
import { materialDungeonUnlocked } from '../src/material-dungeons.js'
import { ErrorCode } from '../src/error-codes.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { taskPackageEligible } from '../src/task-package-scope.js'
import taskPackagePolicy from '../configs/task-package-scope-policy.json' with { type: 'json' }

const state = (extra = {}) => ({ player: { basic_info: { lv: 15 } }, tasks: [], taskRecords: [], ...extra })
const consumers = [
    ['leaf', (s) => taskNodeFinishedCurrentAttempt(s, 106015, 24)],
    ['tasks API', (s) => taskNodeCompleted(s, 106015, 24)],
    ['home compound', (s) => homeCondition('2004#15|12045#106015#24', s)],
    ['home legacy delimiter', (s) => homeCondition('12045|106015|24', s)],
    ['activity progress', (s) => ActivityCatalog.prototype.condition.call({}, '12045|106015|24', s) === 1],
    ['activity unlock', (s) => activityConditionUnlocked('2004#15|12045#106015#24', s)],
    ['material unlock', (s) => materialDungeonUnlocked('2004#15|12045#106015#24', s)],
]
function agree(s, expected) {
    const original = structuredClone(s)
    for (const [name, evaluate] of consumers) assert.equal(evaluate(s), expected, name)
    assert.deepEqual(s, original, 'Status reads must not create or change task/save state')
}

test('all current12045 consumers reject old completed history while the active attempt lacks the exact node', () => {
    agree(
        state({ tasks: [{ task_id: 106015, finish_nodes: [23, 25] }], taskRecords: [{ task_id: 106015, count: 2 }] }),
        false,
    )
    agree(
        state({
            tasks: [
                {
                    task_id: 106015,
                    finish_nodes: [],
                    nodes: [{ node_id: 24, client_before: true, client_cond_after: [true] }],
                },
            ],
            taskRecords: [{ task_id: 106015, count: 1 }],
        }),
        false,
    )
    agree(
        state({ tasks: [{ task_id: 106015, finish_nodes: [24] }], taskRecords: [{ task_id: 106015, count: 1 }] }),
        true,
    )
    agree(state({ tasks: [{ task_id: 106014, finish_nodes: [24] }] }), false)
})

test('archived whole-task completion is legal only without that active attempt and still requires positive saved completion', () => {
    agree(state({ taskRecords: [{ task_id: 106015, count: 1 }] }), true)
    agree(state({ tasks: [{ task_id: 106014, finish_nodes: [] }], taskRecords: [{ task_id: 106015, count: 1 }] }), true)
    agree(state({ taskRecords: [{ task_id: 106015, count: 0 }] }), false)
    agree(state({ taskRecords: [{ task_id: 106014, count: 2 }] }), false)
    assert(taskNodeFinishedCurrentAttempt(state({ taskRecords: [{ task_id: 106015, count: 1 }] }), 106015, 999999))
})

test('the graph-free leaf does not read completion history or mutate even frozen active task state', () => {
    const task = Object.freeze({ task_id: 106015, finish_nodes: Object.freeze([24]) })
    const s = Object.freeze({
        tasks: Object.freeze([task]),
        get taskRecords() {
            throw Error('Active attempt must not read archive')
        },
    })
    assert(taskNodeFinishedCurrentAttempt(s, 106015, 24))
    assert(!taskNodeFinishedCurrentAttempt(s, 106015, 25))
    const missing = Object.freeze({ tasks: Object.freeze([Object.freeze({ task_id: 106015 })]) })
    assert(!taskNodeFinishedCurrentAttempt(missing, 106015, 24))
    assert.deepEqual(Object.keys(missing.tasks[0]), ['task_id'])
})

test('damaged relevant completion state fails explicitly rather than letting historical completion bypass the active task', () => {
    for (const s of [
        state({ tasks: {} }),
        state({ tasks: [{ task_id: 106015, finish_nodes: '24' }], taskRecords: [{ task_id: 106015, count: 1 }] }),
        state({ tasks: [{ task_id: 106015, finish_nodes: ['24'] }] }),
        state({ taskRecords: {} }),
        ...[-1, 1.5, '1', undefined].map((count) => state({ taskRecords: [{ task_id: 106015, count }] })),
    ]) {
        assert.throws(
            () => taskNodeFinishedCurrentAttempt(s, 106015, 24),
            (error) => error.code === ErrorCode.GameConfig,
        )
    }
    assert(
        !taskNodeFinishedCurrentAttempt(state({ taskRecords: [{ task_id: 106014, count: 'unrelated' }] }), 106015, 24),
    )
})

test('existing level, home-level and task-node unlock conditions keep their independent requirements', () => {
    const tables = new Tables(configuration().tables),
        formal = tables.find('task', 106001)
    assert.equal(formal.isReviewMode_tishen, 0)
    // A compound-condition unit fixture, not the real106001 acceptance rule.
    // Keep its actual current id/package metadata before overriding this rule.
    const graph = { config: { ...formal, unlockcondition: '2004#15|12045#106015#24' }, requirements: [] }
    const s = state({ tasks: [{ task_id: 106015, finish_nodes: [24] }], home: { level: 3, stage: 2 } })
    assert(taskUnlocked(graph, s))
    assert(homeCondition('15017#3|12045#106015#24', s))
    assert(homeCondition('11009|2', s))
    s.player.basic_info.lv = 14
    assert(!taskUnlocked(graph, s))
    assert(!homeCondition('2004#15|12045#106015#24', s))
    assert(!activityConditionUnlocked('2004#15|12045#106015#24', s))
    s.player.basic_info.lv = 15
    s.home.level = 2
    assert(!homeCondition('15017#3|12045#106015#24', s))
    s.tasks[0].finish_nodes = [23]
    assert(!taskUnlocked(graph, s))
})

test('current formal/review package metadata gates before the same node rule and missing metadata stays invalid', () => {
    const tables = new Tables(configuration().tables),
        formal = tables.find('task', 106001),
        review = tables.find('task', 106003)
    assert.equal(formal.isReviewMode_tishen, 0)
    assert.equal(review.isReviewMode_tishen, 2)
    assert.equal(taskPackagePolicy.isReviewPackage, false, 'the current server deployment is formal')
    const graph = (config) => ({ config: { ...config, unlockcondition: '2004#15|12045#106015#24' }, requirements: [] })
    const s = state({ tasks: [{ task_id: 106015, finish_nodes: [24] }] })
    assert.equal(taskUnlocked(graph(formal), s), true)
    assert.equal(taskUnlocked(graph(review), s), false)
    assert.equal(
        taskUnlocked(graph(review), { ...s, isReviewPackage: true }),
        false,
        'player flags cannot select the deployment package',
    )
    const reviewDeployment = { ...taskPackagePolicy, isReviewPackage: true }
    assert.equal(taskPackageEligible(formal, reviewDeployment), false)
    assert.equal(taskPackageEligible(review, reviewDeployment), true)
    for (const config of [
        { id: formal.id, unlockcondition: '2004#15|12045#106015#24' },
        { ...formal, isReviewMode_tishen: '0' },
    ])
        assert.throws(
            () => taskUnlocked(graph(config), s),
            (error) => error.code === ErrorCode.GameConfig,
        )
    s.tasks[0].finish_nodes = []
    assert.equal(taskUnlocked(graph(formal), s), false, 'formal package metadata does not complete the tested node')
})

test('real Journey sync cache changes generation when an archived task becomes active, completes a node or returns to archive', () => {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let sequence = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    const syncId = protocol.byName.get('SCProtoJourneySync').id
    const saved = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    const cancel = () => call('JourneyClientTrace')
    const unlocked = (packets, expected) => {
        const sync = packets.find((packet) => packet.id === syncId)
        assert(sync, 'Changed node truth must invalidate the real Journey sync cache')
        assert.equal(sync.data.journey_task.find((row) => row.task_id === 40402).task_is_unlock, expected)
    }
    try {
        call('EnterGame', { open_id: 'task-node-journey-cache-current' })
        // Seed only an unrelated, already-claimed introductory tab prerequisite.
        // The tested40402 uses the real current12045#106010#168 condition.
        edit((s) => {
            s.tasks = s.tasks.filter((row) => row.task_id !== 106010)
            s.taskRecords = (s.taskRecords ?? []).filter((row) => row.task_id !== 106010)
            s.taskRecords.push({ task_id: 106010, count: 1, time: 1799999999 })
            s.journey.tasks[20000] = { complete: true, claimed: true }
            s.journey.claimRevision++
        })
        unlocked(cancel(), true)
        const archiveSignature = saved().journey.sourceSignature
        edit((s) =>
            s.tasks.push({ task_id: 106010, nodes: [], finish_nodes: [], reward_nodes: [], start_time: 1800000000 }),
        )
        unlocked(cancel(), false)
        const activeSignature = saved().journey.sourceSignature
        assert.notEqual(activeSignature, archiveSignature)
        assert(!cancel().some((packet) => packet.id === syncId), 'Unchanged current attempt must not resync repeatedly')
        edit((s) => s.tasks.find((row) => row.task_id === 106010).finish_nodes.push(168))
        unlocked(cancel(), true)
        assert.notEqual(saved().journey.sourceSignature, activeSignature)
        edit((s) => {
            s.tasks.find((row) => row.task_id === 106010).finish_nodes = []
        })
        unlocked(cancel(), false)
        edit((s) => {
            s.tasks = s.tasks.filter((row) => row.task_id !== 106010)
        })
        unlocked(cancel(), true)
        assert(!cancel().some((packet) => packet.id === syncId))
        assert.equal(saved().taskRecords.find((row) => row.task_id === 106010).count, 1)
    } finally {
        store.close()
    }
})
