import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { currentEmptyVictoryTaskChain } from '../src/task-chain-completion.js'
import { storySceneDefeated } from '../src/story-campaign.js'
import { hasVerifiedTaskDungeonClear } from '../src/tasks.js'
import { advanceStoryCampaignTask } from '../src/handlers/story-campaign.js'

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-task-chain-model-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base),
    dungeonId = 10068,
    ids = currentEmptyVictoryTaskChain(tables, dungeonId)
assert.deepEqual(ids, [500011, 500012, 500013, 500014, 500015, 500016])

// Explicit completed-task model, not an earned main-story or dungeon E2E.
// Producer order is independently checked in handlers/tasks.js: TaskFinish
// writes its completion record/receipt before advancing the campaign chain.
function model(id = 777) {
    const state = seedPlayer(tables, id, 'task-chain-model-' + id)
    const dungeon = tables.find('dungeon', dungeonId),
        mapping = tables.get('dungeon_task').find((row) => row.dungeonId === dungeonId),
        points = mapping.taskTeleportIds.split('|').map((point) => tables.find('world_borthpos', Number(point)))
    state.tasks = []
    state.taskRecords = ids.map((task_id) => ({ task_id, count: 1, time: 1800000001 }))
    state.taskFinishReceipts = Object.fromEntries(ids.map((taskId) => [`${taskId}:1`, []]))
    state.world = tables.position(points.at(-1))
    state.storyCampaign = {
        dungeon_id: dungeonId,
        group_id: dungeon.groupId,
        difficulty: dungeon.dungeonGroupOrder,
        instance_id: 11,
        start_time: 1800000000,
        status: 2,
        task_ids: [...ids],
        scenes: [...new Set(points.map((point) => point.cityId))],
        map_id: points.at(-1).cityId,
        completed_scenes: [],
        entry_tasks: [],
        return_world: tables.position(tables.find('world_borthpos', 10045)),
    }
    return state
}

test('current empty global predicate uses the complete declared chain, while missing/active tasks and old clears cannot win the current run', () => {
    const state = model(),
        before = structuredClone(state)
    assert.equal(tables.find('dungeon', dungeonId).victoryCondition, '')
    assert.equal(storySceneDefeated(tables, state), true)
    assert.deepEqual(state, before)
    for (const taskId of ids) {
        const missing = model()
        missing.taskRecords = missing.taskRecords.filter((row) => row.task_id !== taskId)
        missing.storyCampaignClears = { [dungeonId]: { count: 1, time: 1700000000 } }
        assert.equal(storySceneDefeated(tables, missing), false)
        missing.taskRecords = [...before.taskRecords]
        missing.tasks = [{ task_id: taskId, nodes: [] }]
        assert.equal(storySceneDefeated(tables, missing), false)
    }
    const reordered = model()
    reordered.storyCampaign.task_ids.reverse()
    assert.equal(storySceneDefeated(tables, reordered), false)
})

test('historical count/time with six finish receipts and the original ordered task proof remain readable without being used for a fresh run', () => {
    for (const mode of ['receipts', 'proof']) {
        const state = model()
        state.tasks = [{ task_id: ids[0], nodes: [] }]
        state.taskRecords = []
        state.storyCampaignClears = { [dungeonId]: { count: 1, time: 1700000000 } }
        if (mode === 'proof') {
            state.storyCampaignClears[dungeonId].task_proof = { task_ids: [...ids], victory_task_id: ids.at(-1) }
            state.taskFinishReceipts = {}
        }
        const before = structuredClone(state)
        assert.equal(hasVerifiedTaskDungeonClear(tables, state, dungeonId), true)
        assert.equal(storySceneDefeated(tables, state), false)
        assert.deepEqual(state, before)
    }
    const partial = model()
    partial.taskRecords = []
    partial.storyCampaignClears = { [dungeonId]: { count: 1, time: 1700000000 } }
    delete partial.taskFinishReceipts[`${ids[0]}:1`]
    assert.equal(hasVerifiedTaskDungeonClear(tables, partial, dungeonId), false)
})

test('nonempty2007 completion remains unchanged and an unrelated empty dungeon without a declared auto-exit chain is not a win', () => {
    const state = model(),
        dungeon = tables.find('dungeon', 10067),
        mapping = tables.get('dungeon_task').find((row) => row.dungeonId === dungeon.id),
        taskIds = mapping.taskIds.split('|').map(Number)
    state.storyCampaign = { dungeon_id: dungeon.id, task_ids: taskIds }
    state.taskRecords = [{ task_id: taskIds.at(-1), count: 1 }]
    assert.equal(storySceneDefeated(tables, state), true)
    const unrelated = {
        find: (name, id) => (name === 'dungeon' ? { id, victoryCondition: '' } : tables.find(name, id)),
        get: (name) => (name === 'dungeon_task' ? [] : tables.get(name)),
    }
    assert.equal(currentEmptyVictoryTaskChain(unrelated, dungeonId), null)
})

test('actual final advance writes the existing proof shape, auto-exits and preserves an older clear without awarding it twice', () => {
    for (const alreadyCleared of [false, true]) {
        const state = model(),
            messages = []
        if (alreadyCleared) state.storyCampaignClears = { [dungeonId]: { count: 1, time: 1700000000 } }
        const context = {
            tables,
            state,
            id: 777,
            now: 1800000020,
            push: (name, value) => messages.push({ name, value }),
            pushBefore: (name, value) => messages.push({ name, value }),
        }
        advanceStoryCampaignTask(context, ids.at(-1))
        assert.equal(state.storyCampaign, undefined)
        assert.equal(state.storyCampaignClears[dungeonId].count, 1)
        assert.deepEqual(state.storyCampaignClears[dungeonId].task_proof, {
            task_ids: ids,
            victory_task_id: ids.at(-1),
        })
        assert.equal(hasVerifiedTaskDungeonClear(tables, state, dungeonId), true)
        if (alreadyCleared) assert.equal(state.storyCampaignClears[dungeonId].time, 1700000000)
        for (const packet of messages) {
            const entry = protocol.byName.get(packet.name)
            assert(entry?.rsp !== undefined, packet.name)
            protocol.encode(entry.rsp, packet.value)
        }
    }
})

test('codec and late SQL failure roll back final-credit/auto-exit state on a private Store transaction', () => {
    const store = new Store(':memory:')
    const logged = store.login('task-chain-model-transaction', (id) => model(id)),
        accountId = logged.state.player.basic_info.id
    const advance = () =>
        store.transact(accountId, 0, (state) => {
            const context = {
                tables,
                state,
                id: accountId,
                now: 1800000020,
                push: (name, value) => {
                    if (name === 'CSProtoCampaignInfoSync' && failCodec) throw Error('model campaign codec')
                    protocol.encode(protocol.byName.get(name).rsp, value)
                },
            }
            context.pushBefore = context.push
            advanceStoryCampaignTask(context, ids.at(-1))
        })
    let failCodec = true
    try {
        const before = structuredClone(store.load(accountId))
        assert.throws(advance, /model campaign codec/)
        assert.deepEqual(store.load(accountId), before)
        failCodec = false
        store.db.exec(
            "CREATE TEMP TRIGGER reject_chain BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'chain SQL'); END",
        )
        assert.throws(advance, /chain SQL/)
        assert.deepEqual(store.load(accountId), before)
        store.db.exec('DROP TRIGGER reject_chain')
        advance()
        assert.equal(store.load(accountId).state.storyCampaign, undefined)
        assert.equal(hasVerifiedTaskDungeonClear(tables, store.load(accountId).state, dungeonId), true)
    } finally {
        store.close()
    }
})
