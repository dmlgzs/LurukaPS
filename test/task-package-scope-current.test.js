import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, taskUnlocked, unlockAutomaticTasks, taskSnapshot } from '../src/tasks.js'
import {
    taskPackageEligible,
    reconcileTaskPackageScope,
    packageIsolatedTaskIds,
    taskPackageRestoreRequired,
} from '../src/task-package-scope.js'
import { activeFormationManager } from '../src/trial-actors.js'
import { taskEnemyPacks } from '../src/task-enemy-slots.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { combatEntityStates } from '../src/combat-enemy-lifecycle.js'
import { ErrorCode } from '../src/error-codes.js'
import { ensureAppearance } from '../src/appearance.js'
import policy from '../configs/task-package-scope-policy.json' with { type: 'json' }

const hash = (value) =>
        createHash('sha256')
            .update(JSON.stringify(value) ?? '<undefined>')
            .digest('hex'),
    config = configuration(),
    tables = new Tables(config.tables),
    graphs = new TaskGraphs(tables)
const appearance = (s) => ({
    customized: s.characterCustomized,
    name: s.player.basic_info.name,
    sex: s.player.basic_info.sex,
    wardrobe: s.player.basic_info.wardrobe,
    apparel: s.player.basic_info.apparel_info,
    clothes: s.player.basic_info.clothes_info,
})
const histories = (s) => ({
    records: s.taskRecords,
    claims: s.claims,
    claimReceipts: s.taskClaimReceipts,
    sceneReceipts: s.taskSceneReceipts,
    story: s.storyWatches,
    taskEpochs: s.taskEpochs,
})

test('current Native package predicate distinguishes0 and2; other int32 modes stay allowed and damaged fields reject', () => {
    for (const review of [false, true])
        for (const mode of [0, 1, 2, 3, -1])
            assert.equal(
                taskPackageEligible({ isReviewMode_tishen: mode }, { ...policy, isReviewPackage: review }),
                mode === 0 ? !review : mode === 2 ? review : true,
            )
    for (const mode of [undefined, null, '2', 1.5, 0x80000000])
        assert.throws(
            () => taskPackageEligible({ isReviewMode_tishen: mode }),
            (error) => error.code === ErrorCode.GameConfig,
        )
    assert.throws(
        () => taskPackageEligible({ isReviewMode_tishen: 0 }, { ...policy, isReviewPackage: 1 }),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('ordinary automatic acceptance, explicit prerequisites and HUD exclude all review-only current rows without task-ID exceptions', () => {
    const state = seedPlayer(tables, 1, 'package-current-unit'),
        review = tables.get('task').filter((row) => row.isReviewMode_tishen === 2)
    assert.equal(review.length, 2)
    unlockAutomaticTasks(tables, state, 1800000000)
    assert(state.tasks.some((task) => task.task_id === 106001))
    for (const row of review) {
        assert(!state.tasks.some((task) => task.task_id === row.id))
        assert.equal(taskUnlocked(graphs.get(row.id), state), false)
    }
    const snapshot = taskSnapshot(tables, state)
    assert(snapshot.tasks.every((task) => taskPackageEligible(tables.find('task', task.task_id))))
    assert(!review.some((row) => row.id === snapshot.next_main_id))
    assert(!state.taskRecords?.length)
})

test('package isolation archives owned pending references and original epoch while preserving ordinary work and every reward/appearance history', () => {
    const state = seedPlayer(tables, 1, 'package-current-archive')
    const ordinary = {
            task_id: 106001,
            nodes: [{ node_id: 5, node_values: [0], client_before: true }],
            finish_nodes: [1],
            reward_nodes: [],
            client_trace: true,
        },
        review = {
            task_id: 106003,
            nodes: [{ node_id: 5, node_values: [0], client_before: true }],
            finish_nodes: [1, 11],
            reward_nodes: [11],
            client_trace: true,
        }
    state.tasks = [ordinary, review]
    state.taskEpochs = { 106001: 4, 106003: 7 }
    state.characterCustomized = true
    state.taskRecords = [{ task_id: 106003, count: 1, time: 100 }]
    state.claims = ['controlled-history']
    for (const field of ['pendingTaskStorySync', 'pendingTaskScene', 'pendingCharacterTask'])
        state[field] = { task_id: 106003, node_id: 5, controlled: true }
    const before = structuredClone(state),
        originalAppearance = hash(appearance(state)),
        rawHistory = hash(histories(state)),
        combat = hash(state.combat)
    const result = reconcileTaskPackageScope(tables, state, 1800000000)
    assert.deepEqual(result, { changed: true, isolatedIds: [106003] })
    assert.equal(hash(state.tasks), hash([ordinary]))
    assert.equal(hash(appearance(state)), originalAppearance)
    assert.equal(hash(histories(state)), rawHistory)
    assert.equal(hash(state.combat), combat)
    const saved = state.taskPackageIsolation.records[0]
    assert.equal(hash(saved.rawTask), hash(review))
    assert.equal(saved.epoch, 7)
    assert.equal(saved.epochPresent, true)
    for (const field of ['pendingTaskStorySync', 'pendingTaskScene', 'pendingCharacterTask']) {
        assert.equal(state[field], undefined)
        assert.equal(hash(saved.pending[field]), hash(before[field]))
    }
    assert.equal(taskPackageRestoreRequired(state, 106003), true)
    assert.deepEqual(packageIsolatedTaskIds(state), [106003])
    const stable = hash(state)
    assert.deepEqual(reconcileTaskPackageScope(tables, state, 1800000001), { changed: false, isolatedIds: [] })
    assert.equal(hash(state), stable)
    unlockAutomaticTasks(tables, state, 1800000001)
    assert(!state.tasks.some((task) => task.task_id === 106003))
    assert(taskSnapshot(tables, state).del_tasks.includes(106003))
})

test('controlled prior wrong-package instance rolls back all archives and chosen appearance on codec/SQL boundaries', () => {
    const store = new Store(':memory:'),
        state = seedPlayer(tables, 1, 'package-current-rollback')
    state.tasks = [
        { task_id: 106001, nodes: [{ node_id: 5, node_values: [0] }], finish_nodes: [1], reward_nodes: [] },
        { task_id: 106003, nodes: [{ node_id: 5, node_values: [0] }], finish_nodes: [1, 11], reward_nodes: [] },
    ]
    state.characterCustomized = true
    state.player.basic_info.name = Buffer.from('selected-protagonist').toString('base64')
    ensureAppearance(tables, state) // Qualified current chosen appearance, not an unfinished seed placeholder.
    state.pendingTaskStorySync = {
        task_id: 106001,
        node_id: 5,
        stories: [],
        extra: { new_task_ids: [106002, 106003], retained: true },
    }
    store.db.prepare('INSERT INTO accounts(id,open_id,created_at)VALUES(1,?,0)').run('package-current-rollback')
    store.db.prepare('INSERT INTO players(account_id,state,updated_at)VALUES(1,?,0)').run(JSON.stringify(state))
    try {
        const protocol = new Protocol(config.base),
            game = new Game(protocol, store, tables, { ...config, clock: () => 1800000000 }),
            entry = protocol.byName.get('CSProtoEnterGame')
        let seq = 1
        const login = () =>
            game.dispatch(
                {},
                {
                    id: entry.id,
                    seq: seq++,
                    payload: protocol.encode(entry.req, { open_id: 'package-current-rollback' }),
                },
            )
        const before = hash(store.load(1)),
            sql = store.db.prepare('SELECT state,revision FROM players WHERE account_id=1').get()
        const type = protocol.byName.get('CSProtoTaskSync').rsp,
            encode = protocol.encode
        let reached = false
        protocol.encode = function (name, ...args) {
            if (name === type) {
                reached = true
                throw Error('package codec probe')
            }
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(login, /package codec probe/)
            assert.equal(reached, true)
        } finally {
            protocol.encode = encode
        }
        assert.equal(hash(store.load(1)), before)
        store.db.exec(
            "CREATE TRIGGER package_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'package-sql'); END",
        )
        try {
            assert.throws(login, /package-sql/)
        } finally {
            store.db.exec('DROP TRIGGER package_abort')
        }
        assert.equal(hash(store.load(1)), before)
        assert.equal(hash(store.db.prepare('SELECT state,revision FROM players WHERE account_id=1').get()), hash(sql))
        login()
        assert(store.load(1).state.taskPackageIsolation.records.some((row) => row.taskId === 106003))
        assert.equal(hash(appearance(store.load(1).state)), hash(appearance(state)))
    } finally {
        store.close()
    }
})

test('formal story barrier keeps its normal queue while incompatible new-task hints are archived and removed idempotently', () => {
    const state = seedPlayer(tables, 1, 'package-current-extra-refs')
    state.tasks = [{ task_id: 106001, nodes: [{ node_id: 5 }], finish_nodes: [1], reward_nodes: [] }]
    state.pendingTaskStorySync = {
        task_id: 106001,
        node_id: 5,
        stories: [{ story_id: 100101, tag: 0 }],
        extra: { new_task_ids: [106002, 106003], retained: true },
    }
    const original = structuredClone(state.pendingTaskStorySync)
    assert.deepEqual(reconcileTaskPackageScope(tables, state, 1800000000), { changed: true, isolatedIds: [] })
    assert.deepEqual(state.pendingTaskStorySync, { ...original, extra: { ...original.extra, new_task_ids: [106002] } })
    const archived = state.taskPackageIsolation.references[0]
    assert.deepEqual(archived.rawTaskIds, [106002, 106003])
    assert.deepEqual(archived.removedTaskIds, [106003])
    assert.equal(archived.ownerTaskId, 106001)
    const stable = hash(state)
    assert.deepEqual(reconcileTaskPackageScope(tables, state, 1800000001), { changed: false, isolatedIds: [] })
    assert.equal(hash(state), stable)
})

test('fresh ordinary Game admits real wolf AOI and first-wave combat before any creation condition can become active', () => {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        session = {}
    let nowMs = Date.now(),
        seq = 1
    const game = new Game(protocol, store, tables, {
        ...config,
        clock: () => Math.floor(nowMs / 1000),
        arenaClockMs: () => nowMs,
    })
    assert(
        game.handlers.has(protocol.byName.get('CSProtoTryCreateWorldObj').id),
        'Default Game must register current world-object AOI',
    )
    const call = (name, value = {}) => {
            const entry = protocol.byName.get('CSProto' + name)
            return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, value) })
        },
        state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'package-current-first-wave' })
        assert.equal(state().characterCustomized, undefined)
        assert.deepEqual(
            state().tasks.map((task) => task.task_id),
            [106001],
        )
        assert.equal(state().tasks[0].nodes[0].node_id, 5)
        assert.equal(state().world.map_id, 102)
        call('TrialGroupChange', { open: true, trial_id: 1 })
        assert.equal(state().trialGroup.task_id, 106001)
        call('MapLoadFinish')
        call('TaskClientBefore', { task_id: 106001, node_id: 5 })
        const condition = graphs.get(106001).nodes.get(5).__type_TaskConditionNodeData.conditionList[0],
            group = condition.__type_TaskConditionBaseData.__type_TaskCondEnemiesGroupData.enemiesDatas[0],
            packs = taskEnemyPacks(tables, group),
            ids = packs.map((_, slot) => ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(group.createNpcId)).toString())
        assert.equal(packs.length, 2)
        const packets = call('TryCreateWorldObj', { objs: ids }),
            ack = protocol.decode(protocol.byId.get(11234).rsp, packets.find((packet) => packet.id === 11234).payload)
        assert.equal(ack.objs.length, 2)
        assert(ack.objs.every((obj) => obj.agent_uid !== '0'))
        const hpType = protocol.byName.get('CSProtoObjBattleInfoSync'),
            initialHp = new Map(
                packets
                    .filter((packet) => packet.id === hpType.id)
                    .flatMap((packet) => protocol.decode(hpType.rsp, packet.payload).infos)
                    .map((info) => [info.uuid, info.hp]),
            )
        for (const id of ids) assert.equal(initialHp.get(id), enemyDefinition(tables, state(), id).max_hp)
        assert.throws(() => call('TaskClientCondAfter', { task_id: 106001, node_id: 5, indexes: [0] }))
        const manager = activeFormationManager(state()),
            control = manager.groups.find((group) => group.id === manager.cur_group).control
        assert.equal(protocol.byName.get('CSProtoBattleInfoReduce').id, 10705)
        assert.equal(state().trialGroup.heroes.find((hero) => hero.guid === control)?.conf_id, 107001)
        const firstHp = initialHp.get(ids[0])
        call('BattleInfoReduce', {
            base_time: String(++nowMs),
            uint64_dic: [control, ids[0]],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
        })
        assert.equal(combatEntityStates(state().combat)[ids[0]].hp, firstHp - 1)
        assert.equal(combatEntityStates(state().combat)[ids[0]].alive_state ?? 0, 0)
        assert.throws(() => call('TaskClientCondAfter', { task_id: 106001, node_id: 5, indexes: [0] }))
        for (const id of ids) {
            const hp = combatEntityStates(state().combat)[id]?.hp ?? initialHp.get(id)
            call('BattleInfoReduce', {
                base_time: String(++nowMs),
                uint64_dic: [control, id],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hp } }],
            })
            assert.equal(combatEntityStates(state().combat)[id].hp, 0)
        }
        call('TaskClientCondAfter', { task_id: 106001, node_id: 5, indexes: [0] })
        call('TaskClientAfter', { task_id: 106001, node_id: 5 })
        assert(!state().tasks.some((task) => task.task_id === 106003))
        assert.equal(!!state().characterCustomized, false)
        assert(
            state()
                .tasks.find((task) => task.task_id === 106001)
                .nodes.every((node) => node.node_id !== 11),
        )
        assert(
            state()
                .tasks.find((task) => task.task_id === 106001)
                .nodes.some((node) => node.node_id === 61),
        )
    } finally {
        store.close()
    }
})
