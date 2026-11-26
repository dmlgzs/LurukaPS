import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import {
    TaskGraphs,
    nodeConditions,
    conditionSatisfied,
    deferTaskSyncUntilAfterStories,
    flushTaskSyncAfterStories,
    makeNode,
    refreshTaskProgress,
} from '../src/tasks.js'
import { taskActions, prepareTaskScenes, taskBirthPoint } from '../src/task-scenes.js'
import { taskActionData, taskOverrideNodeIds } from '../src/task-action-data.js'
import { applyTaskItemActions } from '../src/task-items.js'
import { taskEnemyGroups } from '../src/task-enemy-groups.js'
import { taskEnemyPacks } from '../src/task-enemy-slots.js'
import { recordWorldDiscovery } from '../src/world-discovery.js'
import { resetCampaignTasks } from '../src/story-campaign.js'
import { hiddenTaskPetGuids } from '../src/task-pet-presentation.js'

const tables = new Tables(configuration().tables),
    graphs = new TaskGraphs(tables)
const all = tables.get('task').map((row) => graphs.get(row.id))

test('current action wrappers restore configured Before/After transfers without rewinding an after scene', () => {
    const graph = graphs.get(106018),
        node = graph.nodes.get(22)
    assert.equal(taskActions(node)[0].__type_TaskTransferBaseData.transferPointId, 25001)
    assert(taskActions(node, 'after').some((data) => data.__type_TaskTransferBaseData?.transferPointId === 25101))
    const state = {
        world: tables.position(tables.find('world_borthpos', 10045)),
        tasks: [{ task_id: 106018, nodes: [{ node_id: 22, client_before: true }] }],
    }
    assert.equal(prepareTaskScenes(tables, state, { login: true }), true)
    assert.equal(state.world.map_id, 250)
    state.world = tables.position(tables.find('world_borthpos', 25101))
    state.taskSceneReceipts = {}
    assert.equal(prepareTaskScenes(tables, state, { login: true }), false)
    assert.equal(state.world.map_id, 251)
    assert.throws(
        () => taskActionData({ __type_TaskActionBaseData: 0, dataType: { __type_TaskTransferBaseData: {} } }),
        /Invalid task action payload/,
    )
    assert.throws(() => taskActionData({ dataType: 0 }), /Invalid task action payload/)
    assert.deepEqual(taskActionData({ dataType: { __type_TaskClearWorldData: {} } }), { __type_TaskClearWorldData: {} })
})

test('current graph item creation spends no duplicate grant on Before retry and validates its real task item', () => {
    let source
    for (const graph of all)
        for (const node of graph.nodes.values()) {
            const action = taskActions(node).find((data) => data.__type_TaskCreatItemData)
            if (action) {
                source = { graph, node, data: action.__type_TaskCreatItemData }
                break
            }
        }
    assert(source, 'current graphs must contain actual item creation evidence')
    const state = { taskItems: [], taskEpochs: {} }
    applyTaskItemActions(tables, state, source.graph.config.id, source.node.id, source.node, 'before')
    assert.equal(state.taskItems.find((item) => item.item_id === source.data.itemId).item_num, source.data.itemCount)
    const before = structuredClone(state)
    applyTaskItemActions(tables, state, source.graph.config.id, source.node.id, source.node, 'before')
    assert.deepEqual(state, before)
})

test('optional static resume follows current client missing-point failure without weakening mandatory transfers', () => {
    const state = {
        world: tables.position(tables.find('world_borthpos', 70101)),
        tasks: [{ task_id: 106003, nodes: [{ node_id: 5, client_before: true }] }],
    }
    const before = structuredClone(state.world)
    assert.equal(prepareTaskScenes(tables, state, { login: true }), false)
    assert.deepEqual(state.world, before)
    assert.equal(state.compatibilityDiagnostics.taskStaticTransfers['106003:0:5'].point_id, 10600301)
    assert.throws(() => taskBirthPoint(tables, 10600301), /Task scene birth point unavailable/)
})

test('current boolean story callbacks establish and flush an actual after-story barrier', () => {
    let source
    for (const graph of all)
        for (const node of graph.nodes.values()) {
            const story = taskActions(node, 'after')
                .map((data) => data.__type_TaskOpenStoryData)
                .find((story) => story?.isPlayEndCb === true)
            if (story) {
                source = { graph, node, story }
                break
            }
        }
    assert(source, 'current graphs must contain an actual begin-callback after story')
    const state = seedPlayer(tables, 9, 'current-story')
    assert.equal(deferTaskSyncUntilAfterStories(state, source.graph.config.id, source.node.id, source.node), true)
    assert.equal(
        flushTaskSyncAfterStories(tables, state, () => assert.fail('story not completed')),
        false,
    )
    state.storyIds = state.pendingTaskStorySync.stories.map((story) => story.story_id)
    let flushed = false
    assert.equal(
        flushTaskSyncAfterStories(tables, state, () => {
            flushed = true
        }),
        true,
    )
    assert(flushed)
    assert.equal(conditionSatisfied({ __type_TaskConditionBaseData: { unneedCompleted: true } }, 0), true)
    assert.equal(conditionSatisfied({ __type_TaskConditionBaseData: { unneedCompleted: 'true' } }, 0), false)
})

test('current controller and NPC overrideNodeIds activate only their configured task nodes', () => {
    let source
    for (const graph of all)
        for (const controller of graph.controllers) {
            const data = controller.__type_TaskCreateBattleUnitDataController?.enemiesDatas?.find(
                (data) => data.sceneId > 0,
            )
            if (data && taskOverrideNodeIds(controller).length) {
                source = { graph, controller, data }
                break
            }
        }
    assert(source)
    const node = taskOverrideNodeIds(source.controller)[0]
    const state = {
        world: { map_id: source.data.sceneId },
        tasks: [{ task_id: source.graph.config.id, nodes: [{ node_id: node }] }],
    }
    assert(taskEnemyGroups(tables, state).some((group) => group.objectId === source.data.createNpcId))
    assert.throws(() => taskOverrideNodeIds({ overrideNodeIds: ['3'], field_530003: [3] }), /Invalid task override/)
    const npcState = { world: { map_id: 100 }, tasks: [{ task_id: 106016, nodes: [{ node_id: 15 }] }] }
    recordWorldDiscovery(tables, npcState, [106016025])
    assert.deepEqual(npcState.worldDiscoveredObjects, [{ map_id: 100, obj_id: 106016025 }])
})

test('current 206001 needs three inline-slot deaths and never accepts partial or wrong pack proof', () => {
    const state = seedPlayer(tables, 10, 'current-kill'),
        graph = graphs.get(206001),
        node = makeNode(graph, 4, state)
    node.client_before = true
    state.world.map_id = 100
    state.tasks = [{ task_id: 206001, nodes: [node], finish_nodes: [1, 3], reward_nodes: [] }]
    const group = nodeConditions(graph.nodes.get(4))[0].__type_TaskConditionBaseData.__type_TaskCondEnemiesGroupData
        .enemiesDatas[0]
    const packs = taskEnemyPacks(tables, group)
    assert.equal(packs.length, 3)
    state.combat = { map_id: 100, entities: {} }
    for (const [slot, pack_id] of packs.entries()) {
        const uuid = ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(group.createNpcId)).toString()
        state.combat.entities[uuid] = { object_id: group.createNpcId, slot, pack_id, hp: 0 }
        refreshTaskProgress(tables, state)
        assert.equal(node.node_values[0], slot === 2 ? 1 : 0)
    }
})

test('current dungeon exit resets only its configured task chain, receipts and playable runs', () => {
    const mapping = tables.get('dungeon_task').find((row) => row.dungeonId === 10020),
        ids = mapping.taskIds.split('|').map(Number)
    const state = {
        tasks: [...ids, 106001].map((task_id) => ({ task_id, nodes: [], finish_nodes: [] })),
        taskRecords: [...ids, 106002].map((task_id) => ({ task_id, count: 1 })),
        pendingTaskScene: { task_id: ids[0] },
    }
    const result = resetCampaignTasks(tables, state, {
        dungeon_id: 10020,
        task_ids: ids,
        status: 2,
        scenes: [],
        entry_tasks: [],
    })
    assert.deepEqual(result.del_tasks, ids)
    assert.deepEqual(
        state.tasks.map((task) => task.task_id),
        [106001],
    )
    assert.deepEqual(
        state.taskRecords.map((task) => task.task_id),
        [106002],
    )
    assert.equal(state.pendingTaskScene, undefined)
})

test('current pageGetPet string and boolean flags retain every owned pet while narrowing the selected presentation', () => {
    const rank = tables.get('pet_rank')[0],
        selected = { guid: '100', config_id: rank.petId },
        other = { guid: '101', config_id: rank.petId }
    const state = {
        tasks: [{ task_id: 106010, nodes: [{ node_id: 183, node_values: [0], client_cond_after: [false] }] }],
        taskPetChoices: { 106010: rank.petGroup },
        pets: [selected, other],
        playableChoiceReceipts: { '106010:0:60001': { pet_group: rank.petGroup, pet_guid: selected.guid } },
    }
    assert.deepEqual(hiddenTaskPetGuids(tables, state), ['101'])
    assert.equal(state.pets.length, 2)
    state.tasks[0].nodes[0].client_cond_after[0] = true
    assert.deepEqual(hiddenTaskPetGuids(tables, state), [])
})
