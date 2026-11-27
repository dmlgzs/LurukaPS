import assert from 'node:assert/strict'
import { runCurrentConditionAfterQueue } from './prefix-correction-condition-phase.js'
import { taskActions } from '../src/task-scenes.js'
import { nodeConditions, conditionValue, asList } from '../src/tasks.js'
import { taskEnemyPacks } from '../src/task-enemy-slots.js'
import { taskOverrideNodeIds } from '../src/task-action-data.js'
import { temporaryHeroes } from '../src/trial-actors.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { enemyDefinition } from '../src/enemy-state.js'

// Explicit local completion inputs around real RPCs. Unknown task actions and
// unproved world-object mechanisms fail; this is not a Unity simulation.
export function normalSuccessorFlow(
    f,
    first,
    {
        objectCompletion,
        afterSourceAction,
        playableCompletion,
        guidedCompletion,
        npcStoryCompletion,
        conditionAfterLifecycle,
        dungeonCompletion,
    } = {},
) {
    const { graphs, call, move, playStory } = first
    const world = new WorldObjectCatalog(f.tables)
    const actions = [],
        visits = [],
        deferredGuides = new Set()
    const local = new Set([
        'TaskBlackData',
        'TaskBlackDialogData',
        'TaskSetLookAtData',
        'TaskCameraGazeData',
        'TaskCreatNPCExportData',
        'TaskDeleteNPCExportData',
        'TaskClearWorldData',
        'TaskPlayWorldCameraData',
        'TaskDisableSystemFunctionByTaskBlockData',
        'TaskDisableTransferData',
        'TaskEnvironmentData',
        'TaskOpenPageData',
        'TaskTimeLockData',
        'TaskCreateBattleUnitData',
    ])
    const perform = (taskId, node, phase) => {
        for (const union of taskActions(node, phase)) {
            const keys = Object.keys(union).filter((key) => key.startsWith('__type_'))
            assert.equal(keys.length, 1)
            const kind = keys[0].slice(7),
                data = union[keys[0]]
            actions.push({ taskId, nodeId: node.id, phase, kind, data, localModel: true })
            if (kind === 'TaskOpenStoryData') playStory(data.storyId)
            else if (kind === 'TaskTransferBaseData') {
                const point = f.tables.find('world_borthpos', data.transferPointId)
                assert(point)
                call('EnterWorldMap', { map_id: point.cityId, point_id: point.id, task_id: taskId, node_id: node.id })
                assert.equal(f.state().world.point_id, point.id)
            } else if (kind === 'TaskTeamChangeData') {
                const controllers = graphs
                    .get(taskId)
                    .controllers.filter(
                        (row) => row.__type_TaskTeamController && taskOverrideNodeIds(row).includes(node.id),
                    )
                assert.equal(controllers.length, 1)
                call('TrialGroupChange', { open: true, trial_id: controllers[0].__type_TaskTeamController.trialsId })
            } else if (kind === 'TaskEquipPetData') {
                const slot = f.currentGroup().heros[data.teamIndex]
                const pet = f.state().pets.find((row) => row.config_id === data.petConfigId)
                assert(slot?.hero_id && pet)
                call('WearPet', { hero_guid: slot.hero_id, pet_guid: pet.guid })
            } else if (kind === 'TaskDelayData') f.advanceMs(Math.ceil(data.delayTime * 1000))
            else if (kind === 'TaskTriggerGuideData') deferredGuides.add(data.guideId)
            else if (!local.has(kind)) {
                assert(afterSourceAction, 'Unmodelled current action: ' + kind)
                assert.equal(afterSourceAction(kind, data, { f, call }), true, 'Unproved current action: ' + kind)
            }
        }
    }
    const damage = (target, delta) => {
        f.advanceMs(2)
        call('BattleInfoReduce', {
            base_time: String(f.nowMs()),
            uint64_dic: [f.currentGroup().control, target],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
        })
    }
    const worldBattle = (data) => {
        const { row, pos } = world.object(f.state().world.map_id, data.npcId)
        const group = f.tables.find('world_enemy_group', row.expandId)
        const packs = String(group?.enemyList ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number)
        assert(packs.length)
        move(pos)
        for (const [slot, pack] of packs.entries()) {
            const target = ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString()
            const definition = enemyDefinition(f.tables, f.state(), target)
            assert.equal(definition.pack_id, pack)
            assert(definition.max_hp > 0)
            const hp = f.state().combat?.entities?.[target]?.hp ?? definition.max_hp
            damage(target, -hp)
            assert.equal(f.state().combat.entities[target].hp, 0)
        }
    }
    const complete = (taskId, node, condition, index) => {
        const base = condition.__type_TaskConditionBaseData
        if (condition.conditionId === 2508) {
            assert(base.__type_TaskCondOpenPageData)
            call('ClientBehaviourRecord', { key: 2508, args: [taskId, 1] })
        } else if (condition.conditionId === 2519) {
            const active = base.__type_TaskCondActiveNPCTriggerData
            const scene = base.__type_TaskCondInSceneData
            const download = base.__type_TaskCondPackageDownloadCompleteData
            let target
            if (active) {
                const sources = active.isNowCreate
                    ? [active.npcData]
                    : graphs
                          .get(taskId)
                          .npcs.filter(
                              (npc) =>
                                  npc.createNpcId === active.createNpcId && taskOverrideNodeIds(npc).includes(node.id),
                          )
                assert.equal(sources.length, 1, 'Unique scoped current NPC source')
                const npc = sources[0]
                assert.equal(npc.sceneId, f.state().world.map_id)
                move({ x: npc.posX, y: npc.posY, z: npc.posZ })
                if (active.storyId > 0) {
                    if (npcStoryCompletion) npcStoryCompletion(active, { taskId, node, index, f, call })
                    else {
                        assert.equal(taskId, 106010)
                        assert([177, 156].includes(node.id), 'Unproved current NPC story sender')
                        assert.equal(active.storyTag, -1)
                        const row = f.tables.find('story', active.storyId)
                        assert.equal(row.storyType, node.id === 177 ? 0 : 1)
                        // ActiveNPC0602e556 uses WaitFlowPlayStoryHandler. Current
                        // StoryController(type0) / NpcDialog.DoEnd(type1) report6060.
                        // EndTag0 and UI click count0 are explicit bounded local
                        // automatic-play inputs, not a recovered renderer branch.
                        playStory(active.storyId)
                    }
                }
                target = active.isNowCreate ? npc.createNpcId : active.createNpcId
            } else if (scene) {
                if (f.state().world.map_id !== scene.sceneId) {
                    // This condition names the real current-world portal. Its
                    // destination comes from that entity's action10 override,
                    // never from an arbitrary birth row or a forged task action.
                    const { row, spawner, pos } = world.object(f.state().world.map_id, base.mapData.targetId)
                    assert.equal(spawner.objectType, 303)
                    const options = String(row.interactOptions).split('|').map(Number)
                    assert(options.some((id) => f.tables.find('world_interact', id)?.interactAction === 10))
                    const params = String(row.interactOverrideParams)
                        .split('|')
                        .map((item) => item.split('#').map(Number))
                    const destinations = params.filter(([action]) => action === 10)
                    assert.equal(destinations.length, 1)
                    assert.equal(destinations[0].length, 2)
                    const point = f.tables.find('world_borthpos', destinations[0][1])
                    assert.equal(point?.cityId, scene.sceneId)
                    move(pos)
                    call('EnterWorldMap', {
                        map_id: point.cityId,
                        point_id: point.id,
                        creator_id: f.state().player.basic_info.id,
                    })
                }
                assert.equal(f.state().world.map_id, scene.sceneId)
                target = scene.sceneId
            } else if (download)
                target = 0xffffffff // explicit local current package-ready input
            else assert.fail('Unmodelled typed2519: ' + JSON.stringify(base))
            call('ClientBehaviourRecord', { key: 2519, args: [target, taskId, node.id, index, 1] })
        } else if (condition.conditionId === 1001) {
            const data = base.__type_TaskCondNPCTriggerData
            assert(data)
            const { pos } = world.object(f.state().world.map_id, data.npcId)
            move(pos)
            if (data.storyId > 0) {
                assert(npcStoryCompletion, 'Current fixed NPC story source is required')
                npcStoryCompletion(data, { taskId, node, index, f, call })
            }
            call('ClientBehaviourRecord', { key: 1001, args: [data.npcId, taskId, node.id, index, 1] })
        } else if (condition.conditionId === 2521) {
            assert(objectCompletion, 'Current world mechanism model is not yet proven')
            objectCompletion(base.__type_TaskCondEntityStatusData, { f, call, move, world })
        } else if (condition.conditionId === 2500) {
            assert.equal(base.__type_TaskCondBattleTriggerData?.checkNameType, 5)
            worldBattle(base.__type_TaskCondBattleTriggerData)
        } else if (condition.conditionId === 2520) {
            const data = base.__type_TaskCondEnemiesGroupData
            assert(data && !data.useExistEnemy)
            const groups = asList(data.enemiesDatas)
            assert(groups.length)
            for (const group of groups) {
                assert.equal(group.sceneId, f.state().world.map_id)
                move({ x: group.posX, y: group.posY, z: group.posZ })
                for (const [slot, pack] of taskEnemyPacks(f.tables, group).entries()) {
                    const target = ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(group.createNpcId)).toString()
                    const definition = enemyDefinition(f.tables, f.state(), target)
                    assert.equal(definition.pack_id, pack)
                    const hp = f.state().combat?.entities?.[target]?.hp ?? definition.max_hp
                    assert(hp > 1)
                    damage(target, -1)
                    assert.equal(f.state().combat.entities[target].hp, hp - 1)
                    damage(target, -(hp - 1))
                    assert.equal(f.state().combat.entities[target].hp, 0)
                }
            }
            call('ClientBehaviourRecord', { key: 2520, args: [data.createNpcId, taskId, node.id, index, 1] })
        } else if (condition.conditionId === 2525) {
            assert(playableCompletion, 'Unmodelled actual playable completion')
            playableCompletion(base.__type_TaskCondCompletePlayableData, { f, call, move, world, taskId, node, index })
        } else if (condition.conditionId === 2518) {
            assert(guidedCompletion, 'Unmodelled actual guided condition input')
            guidedCompletion(condition, { f, call, move, world, taskId, node, index })
        } else if (condition.conditionId === 12017) {
            assert(dungeonCompletion, 'Current dungeon completion model is required')
            dungeonCompletion(base.__type_TaskCondDungeonData, { f, call, move, taskId, node, index })
            assert(conditionValue(condition, f.state(), { taskId, nodeId: node.id, index }) > 0)
        } else if (condition.conditionId === 2004) {
            assert(conditionValue(condition, f.state(), { taskId, nodeId: node.id, index }) > 0)
        } else assert.fail('Unmodelled current condition ' + condition.conditionId)
    }
    const step = (taskId) => {
        const task = f.state().tasks.find((row) => row.task_id === taskId)
        assert(task?.nodes.length === 1, 'Unique actual active task node required')
        const node = graphs.get(taskId).nodes.get(task.nodes[0].node_id)
        visits.push({ taskId, nodeId: node.id, mapId: f.state().world.map_id })
        perform(taskId, node, 'before')
        if (node.nodeType === 50) {
            call('TaskFinish', { u32: taskId })
            return
        }
        const request = { task_id: taskId, node_id: node.id }
        call('MultiTaskClientBefore', { task_params: [request] })
        const conditions = nodeConditions(node)
        const required = conditions
            .map((condition, index) => ({ condition, index }))
            .filter(({ condition }) => !condition.__type_TaskConditionBaseData?.unneedCompleted)
        for (const { condition, index } of required) complete(taskId, node, condition, index)
        for (const id of deferredGuides) call('GuideUpdate', { id, sub_id: 0 })
        deferredGuides.clear()
        const phaseHandled =
            !conditionAfterLifecycle &&
            runCurrentConditionAfterQueue(
                f,
                first,
                taskId,
                node,
                required.map(({ index }) => index),
            )
        const conditional = conditionAfterLifecycle?.start(
            taskId,
            node,
            required.map(({ index }) => index),
        )
        if (required.length && !phaseHandled) {
            if (conditionAfterLifecycle?.report)
                conditionAfterLifecycle.report(
                    taskId,
                    node,
                    required.map(({ index }) => index),
                )
            else
                call('MultiTaskClientCondAfter', {
                    task_params: [{ ...request, indexes: required.map(({ index }) => index) }],
                })
        }
        conditionAfterLifecycle?.complete(conditional)
        perform(taskId, node, 'after')
        call('MultiTaskClientAfter', { task_params: [request] })
        assert(
            !f
                .state()
                .tasks.find((row) => row.task_id === taskId)
                ?.nodes.some((row) => row.node_id === node.id),
            'Actual node did not advance: ' + taskId + '/' + node.id,
        )
    }
    return { step, perform, complete, worldBattle, actions, visits, world, temporaryHeroes }
}
