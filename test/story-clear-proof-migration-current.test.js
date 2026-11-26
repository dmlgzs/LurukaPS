// LOCAL trusted-save bootstrap; these are server integrity tests, not client playthroughs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { TaskGraphs, makeNode, hasVerifiedTaskDungeonClear } from '../src/tasks.js'
import {
    bootstrapStoryClearProofs,
    initializeFreshStoryClearProofState,
    hasHistoricalParentDungeonClear,
    validateStoryClearProofPolicy,
} from '../src/story-clear-proof-migration.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
const artifact = JSON.parse(readFileSync(new URL('./fixtures/story-clear-proof10.json', import.meta.url), 'utf8'))
const policy = JSON.parse(
    readFileSync(new URL('../configs/story-clear-proof-compatibility.json', import.meta.url), 'utf8'),
)
const clear = () => structuredClone(artifact.clear)
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const request = { task_id: 107016, node_id: 41, indexes: [0] }
const currentIds = tables
    .get('dungeon_task')
    .find((row) => row.dungeonId === 10031)
    .taskIds.split('|')
    .map(Number)
const addedIds = currentIds.filter((id) => !artifact.clear.task_proof.task_ids.includes(id))
function baseline(id, openId) {
    const state = seedPlayer(tables, id, openId),
        prior = new Set(),
        levels = []
    function visit(taskId) {
        const row = tables.find('task', taskId)
        assert(row)
        for (const part of String(row.unlockcondition).split('|')) {
            const [kind, target] = part.split('#').map(Number)
            if (kind === 2004) levels.push(target)
            if (kind === 2007 && !prior.has(target)) {
                prior.add(target)
                visit(target)
            }
        }
    }
    visit(107016)
    assert(!prior.has(107016) && addedIds.every((id) => !prior.has(id)))
    state.taskRecords = [...prior].map((task_id) => ({ task_id, count: 1, time: 1 }))
    state.player.basic_info.lv = Math.max(state.player.basic_info.lv, ...levels)
    const graph = new TaskGraphs(tables).get(107016),
        finished = new Set()
    function predecessor(nodeId) {
        if (nodeId === graph.start) return
        for (const previous of graph.nodes.get(nodeId).prevNodeIdList ?? []) {
            assert(graph.nodes.has(previous))
            if (finished.has(previous)) continue
            finished.add(previous)
            predecessor(previous)
        }
    }
    predecessor(41)
    Object.assign(state.world, tables.position(tables.find('world_borthpos', 10053)))
    state.tasks = [
        {
            task_id: 107016,
            nodes: [makeNode(graph, 41, state)],
            finish_nodes: [...finished],
            reward_nodes: [],
            client_trace: true,
            start_time: 1,
        },
    ]
    state.storyCampaignClears = { 10031: clear() }
    return state
}
function fixture(name, { legacy = true, transform } = {}) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1,
        account
    if (legacy)
        account = store.login(name, (id, openId) => {
            const state = baseline(id, openId)
            transform?.(state)
            return state
        })
    const call = (name, value = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: row.id,
            seq: seq++,
            payload: row.req ? protocol.encode(row.req, value) : Buffer.alloc(0),
        })
    }
    return {
        protocol,
        store,
        game,
        call,
        login: () => call('EnterGame', { open_id: name }),
        reload: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        state: () => store.load(session.id ?? account.id).state,
        edit: (fn) => store.transact(session.id ?? account.id, 0, fn),
        sql: () =>
            store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id ?? account.id),
    }
}
const node = (state) => state.tasks.find((row) => row.task_id === 107016)?.nodes.find((row) => row.node_id === 41)
function assertNoNewCompletions(state) {
    for (const id of addedIds) {
        assert(!state.taskRecords?.some((row) => row.task_id === id && row.count > 0))
        assert(!state.taskFinishReceipts?.[id])
    }
    assert.equal(hasVerifiedTaskDungeonClear(tables, state, 10031), false)
}

test('historical writer artifact bootstraps once without mutating proof/assets or granting current fifteen-task victory', () => {
    assert.equal(hash(artifact.clear), artifact.provenance.rawClearSha256)
    assert.equal(currentIds.length, 15)
    assert.equal(addedIds.length, 5)
    const state = baseline(1, 'pure-legacy'),
        before = structuredClone(state)
    assert.deepEqual(bootstrapStoryClearProofs(tables, state), { changed: true, imported: [10031] })
    assert.deepEqual(state.storyCampaignClears, before.storyCampaignClears)
    assert.deepEqual(state.player, before.player)
    assert.deepEqual(state.taskRecords, before.taskRecords)
    assert.equal(state.storyCampaign, undefined)
    const unchanged = structuredClone(state)
    delete unchanged.storyClearProofMigration
    assert.deepEqual(unchanged, before)
    assertNoNewCompletions(state)
    assert.equal(hasHistoricalParentDungeonClear(tables, state, 10031), true)
    const after = structuredClone(state)
    assert.deepEqual(bootstrapStoryClearProofs(tables, state), { changed: false, imported: [] })
    assert.deepEqual(state, after)
    delete state.storyCampaignClears[10031]
    assert.equal(hasHistoricalParentDungeonClear(tables, state, 10031), false)
})

test('bootstrap rejects no-proof/count/record fallback, incomplete/reordered/extended proof, and zero earned count', () => {
    for (const change of [
        (s) => {
            delete s.storyCampaignClears[10031].task_proof
            s.taskRecords.push(...artifact.clear.task_proof.task_ids.map((task_id) => ({ task_id, count: 1 })))
        },
        (s) => {
            s.storyCampaignClears[10031].task_proof.task_ids.pop()
        },
        (s) => {
            s.storyCampaignClears[10031].task_proof.task_ids.reverse()
        },
        (s) => {
            s.storyCampaignClears[10031].task_proof.extra = 1
        },
        (s) => {
            s.storyCampaignClears[10031].task_proof.victory_task_id = 104009
        },
        (s) => {
            s.storyCampaignClears[10031].task_proof.task_ids[0] = 104002
        },
        (s) => {
            s.storyCampaignClears[10031].count = 0
        },
    ]) {
        const state = baseline(1, 'not-supported')
        change(state)
        const original = structuredClone(state.storyCampaignClears)
        assert.deepEqual(bootstrapStoryClearProofs(tables, state).imported, [])
        assert.equal(hasHistoricalParentDungeonClear(tables, state, 10031), false)
        assert.deepEqual(state.storyCampaignClears, original)
    }
})

test('fresh and already-bootstrapped states cannot import subsequently inserted ten-task proof', () => {
    for (const fresh of [true, false]) {
        const state = seedPlayer(tables, 1, 'one-shot')
        if (fresh) initializeFreshStoryClearProofState(state)
        else bootstrapStoryClearProofs(tables, state)
        state.storyCampaignClears = { 10031: clear() }
        assert.deepEqual(bootstrapStoryClearProofs(tables, state), { changed: false, imported: [] })
        assert.equal(hasHistoricalParentDungeonClear(tables, state, 10031), false)
    }
})

test('source/target fingerprints, owner and archived raw bytes are strict; current fifteen-task proof remains authoritative', () => {
    const changedPolicy = structuredClone(policy)
    changedPolicy.entries[0].historical.taskIds[0]++
    assert.throws(() => validateStoryClearProofPolicy(changedPolicy), { code: ErrorCode.GameConfig })
    const state = baseline(1, 'integrity'),
        before = structuredClone(state)
    const changedTables = {
        find: tables.find.bind(tables),
        get: (name) =>
            name === 'dungeon_task'
                ? tables
                      .get(name)
                      .map((row) => (row.dungeonId === 10031 ? { ...row, taskIds: row.taskIds + '|104099' } : row))
                : tables.get(name),
    }
    assert.throws(() => bootstrapStoryClearProofs(changedTables, state), { code: ErrorCode.GameConfig })
    assert.deepEqual(state, before)
    bootstrapStoryClearProofs(tables, state)
    for (const change of [
        (s) => {
            s.storyClearProofMigration.owner_id++
        },
        (s) => {
            s.storyClearProofMigration.bridges[10031].raw_clear.time++
        },
        (s) => {
            s.storyClearProofMigration.version++
        },
    ]) {
        const bad = structuredClone(state)
        change(bad)
        assert.throws(() => bootstrapStoryClearProofs(tables, bad), { code: ErrorCode.GameConfig })
    }
    state.storyCampaign = { dungeon_id: 10031, status: 2 }
    assert.equal(hasHistoricalParentDungeonClear(tables, state, 10031), false)
    delete state.storyCampaign
    state.storyCampaignClears[10031] = {
        count: 1,
        time: 1800000000,
        task_proof: { victory_task_id: 104010, task_ids: currentIds },
    }
    assert.equal(hasHistoricalParentDungeonClear(tables, state, 10031), false)
    assert.equal(hasVerifiedTaskDungeonClear(tables, state, 10031), true)
})

test('default Game cold login/reconnect recovers the safe parent41 to42 without new internal completion or earned assets', () => {
    const f = fixture('proof10-cold')
    try {
        const original = f.state(),
            raw = structuredClone(original.storyCampaignClears)
        f.login()
        assert.equal(f.state().storyClearProofMigration.origin, 'bootstrap')
        assert.equal(hasHistoricalParentDungeonClear(tables, f.state(), 10031), true)
        assertNoNewCompletions(f.state())
        assert.deepEqual(f.state().storyCampaignClears, raw)
        const parent = f.state().tasks.find((row) => row.task_id === 107016)
        assert(parent.finish_nodes.includes(41))
        assert.deepEqual(
            parent.nodes.map((row) => row.node_id),
            [42],
        )
        const assets = structuredClone(f.state().player.basic_info),
            bridge = structuredClone(f.state().storyClearProofMigration)
        f.reload()
        assert.deepEqual(f.state().storyClearProofMigration, bridge)
        f.call('TaskClientCondAfter', request)
        assert.equal(node(f.state()), undefined)
        assert.deepEqual(
            f
                .state()
                .tasks.find((row) => row.task_id === 107016)
                .nodes.map((row) => row.node_id),
            [42],
        )
        f.call('TaskClientCondAfter', request)
        assert.deepEqual(f.state().player.basic_info, assets)
        assert.deepEqual(f.state().storyCampaignClears, raw)
        assertNoNewCompletions(f.state())
    } finally {
        f.store.close()
    }
})

test('default Game fresh seed marker blocks later proof10 insertion on reconnect', () => {
    const f = fixture('proof10-fresh', { legacy: false })
    try {
        f.login()
        assert.equal(f.state().storyClearProofMigration.origin, 'fresh')
        f.edit((s) => {
            s.storyCampaignClears = { 10031: clear() }
        })
        f.reload()
        assert.deepEqual(f.state().storyClearProofMigration.bridges, {})
        assert.equal(hasHistoricalParentDungeonClear(tables, f.state(), 10031), false)
    } finally {
        f.store.close()
    }
})

test('default Game codec and SQL failures roll back bootstrap sidecar and raw state, retry remains eligible', () => {
    for (const failure of ['codec', 'sql']) {
        const f = fixture('proof10-rollback-' + failure),
            encode = f.protocol.encode,
            save = f.store.savePlayer,
            before = f.state(),
            sql = f.sql()
        try {
            if (failure === 'codec')
                f.protocol.encode = function (name, ...args) {
                    if (name === f.protocol.byName.get('CSProtoTaskSync').rsp) throw Error('proof10-codec')
                    return encode.call(this, name, ...args)
                }
            else
                f.store.savePlayer = {
                    run() {
                        throw Error('proof10-sql')
                    },
                }
            assert.throws(() => f.login(), new RegExp('proof10-' + failure))
            assert.deepEqual(f.state(), before)
            assert.deepEqual(f.sql(), sql)
            f.protocol.encode = encode
            f.store.savePlayer = save
            f.login()
            assert.equal(hasHistoricalParentDungeonClear(tables, f.state(), 10031), true)
            assert.deepEqual(f.state().storyCampaignClears, before.storyCampaignClears)
        } finally {
            f.protocol.encode = encode
            f.store.savePlayer = save
            f.store.close()
        }
    }
})

test('real CampaignCreate/reconnect starts current fifteen-task run; historical parent bridge cannot clear or acknowledge active run', () => {
    // Produce the unfinished run with the real current entry handler, then
    // import that RAM save as an unversioned pre-bootstrap profile retaining
    // the historical writer artifact. No new task completion is manufactured.
    const producer = fixture('proof10-entry-producer', {
        transform: (s) => {
            delete s.storyCampaignClears
        },
    })
    let active
    try {
        producer.login()
        producer.call('CampaignCreate', { group_id: 205, difficulty: 2 })
        producer.call('StartDungeonClientOk')
        active = producer.state()
    } finally {
        producer.store.close()
    }
    const f = fixture('proof10-reenter', {
        transform: (s) => {
            Object.assign(s, structuredClone(active))
            delete s.storyClearProofMigration
            s.storyCampaignClears = { 10031: clear() }
        },
    })
    try {
        f.login()
        const raw = structuredClone(f.state().storyCampaignClears),
            bridge = structuredClone(f.state().storyClearProofMigration),
            exp = f.state().player.basic_info.exp
        assert.equal(f.state().storyCampaign.dungeon_id, 10031)
        assert.equal(f.state().storyCampaign.status, 2)
        assert.deepEqual(f.state().storyCampaign.task_ids, currentIds)
        assert.equal(hasHistoricalParentDungeonClear(tables, f.state(), 10031), false)
        assert.equal(hasVerifiedTaskDungeonClear(tables, f.state(), 10031), false)
        assert.equal(node(f.state()).client_before, false)
        assert.throws(() => f.call('TaskClientCondAfter', request), /pre-action is not acknowledged/)
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
        f.reload()
        assert.equal(f.state().storyCampaign.status, 2)
        assert.deepEqual(f.state().storyCampaignClears, raw)
        assert.deepEqual(f.state().storyClearProofMigration, bridge)
        assert.equal(f.state().player.basic_info.exp, exp)
        assertNoNewCompletions(f.state())
    } finally {
        f.store.close()
    }
})
