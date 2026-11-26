import assert from 'node:assert/strict'
import { TaskGraphs, asList, nodeConditions } from '../src/tasks.js'
import { taskActions } from '../src/task-scenes.js'
import { taskOverrideNodeIds } from '../src/task-action-data.js'
import { taskEnemyPacks } from '../src/task-enemy-slots.js'
import { enemyDefinition } from '../src/enemy-state.js'

// This bounded client model consumes the CURRENT task actions. It models local
// story/mask/camera completions, not Unity rendering. All server-owned task,
// combat, transfer, guide, customization and reward changes use actual RPCs.
export function normalCreatorDriver(f, onPackets = () => {}) {
    const graph = new TaskGraphs(f.tables).get(106001),
        actions = [],
        visits = []
    const call = (name, value = {}) => {
        const packets = f.call(name, value)
        onPackets(packets)
        return packets
    }
    const active = () => {
        const task = f.state().tasks.find((row) => row.task_id === 106001)
        assert(task && task.nodes.length === 1, 'current formal prologue must have one genuine active node')
        return task.nodes[0]
    }
    const localOnly = new Set([
        '__type_TaskCreatNPCExportData',
        '__type_TaskDeleteNPCExportData',
        '__type_TaskClearWorldData',
        '__type_TaskPlayWorldCameraData',
        '__type_TaskBlackData',
    ])
    const performActions = (nodeId, phase) => {
        for (const [index, union] of taskActions(graph.nodes.get(nodeId), phase).entries()) {
            const kinds = Object.keys(union).filter((key) => key.startsWith('__type_'))
            assert.equal(kinds.length, 1)
            const kind = kinds[0],
                data = union[kind]
            const record = {
                nodeId,
                phase,
                index,
                kind,
                data,
                model: 'current-client-local-completion',
                renderedByUnity: false,
            }
            actions.push(record)
            if (kind === '__type_TaskOpenStoryData') {
                const story = f.tables.find('story', data.storyId)
                assert(story && Number.isInteger(story.storyType))
                // StoryController.SetPlayParam06005cb8 takes TDStory.storyType;
                // its current end sender writes that value to6060. Tag0 and
                // zero UI clicks are explicit local completion-model inputs.
                call('SetStoryId', {
                    story_id: data.storyId,
                    story_type: story.storyType,
                    tag: 0,
                    is_skip: false,
                    param: 0,
                })
                record.rpc = 6060
                record.completion = 'TaskEntityOpenStory.PlayStoryOver0602e461/StepOver1'
            } else if (kind === '__type_TaskTransferBaseData') {
                const point = f.tables.find('world_borthpos', data.transferPointId)
                assert(point)
                call('EnterWorldMap', { map_id: point.cityId, point_id: point.id, task_id: 106001, node_id: nodeId })
                assert.equal(f.state().world.point_id, point.id)
                record.rpc = 9100
            } else if (kind === '__type_TaskDelayData') {
                assert(Number.isFinite(data.delayTime) && data.delayTime >= 0)
                f.advanceMs(Math.ceil(data.delayTime * 1000))
            } else if (kind === '__type_TaskTeamChangeData') {
                const controllers = graph.controllers.filter(
                    (row) => row.__type_TaskTeamController && taskOverrideNodeIds(row).includes(nodeId),
                )
                assert.equal(controllers.length, 1)
                const id = controllers[0].__type_TaskTeamController.trialsId
                call('TrialGroupChange', { open: true, trial_id: id })
                assert.equal(f.state().trialGroup.current_group_id, id)
                record.rpc = 5987
            } else if (kind === '__type_TaskTriggerGuideData') {
                call('GuideUpdate', { id: data.guideId, sub_id: 0 })
                record.rpc = 6701
            } else {
                assert(localOnly.has(kind), 'unmodelled current local action: ' + kind)
                // These actions have no invented server-complete call here.
                // Their actual client completion is the input to the later
                // aggregate TaskClientBefore/After RPC, never a state edit.
                record.completion = 'explicit local visual-action completion input'
            }
        }
    }
    const damage = (id, delta) => {
        f.advanceMs(2)
        call('BattleInfoReduce', {
            base_time: String(f.nowMs()),
            uint64_dic: [f.currentGroup().control, id],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
        })
    }
    const completeCondition = (condition, index, nodeId) => {
        const base = condition.__type_TaskConditionBaseData
        if (condition.conditionId === 2520) {
            const data = base.__type_TaskCondEnemiesGroupData
            const ids = asList(data.enemiesDatas).flatMap((row) =>
                taskEnemyPacks(f.tables, row).map((_, slot) =>
                    ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(row.createNpcId)).toString(),
                ),
            )
            assert(ids.length > 0)
            for (const id of ids) {
                const definition = enemyDefinition(f.tables, f.state(), id)
                assert(definition?.max_hp > 1)
                const before = f.state().combat.entities[id]?.hp ?? definition.max_hp
                damage(id, -1)
                assert.equal(f.state().combat.entities[id].hp, before - 1)
                const hp = f.state().combat.entities[id].hp
                damage(id, -hp)
                assert.equal(f.state().combat.entities[id].hp, 0)
                assert.equal(f.state().combat.entities[id].alive_state, 1)
            }
            call('ClientBehaviourRecord', { key: 2520, args: [data.createNpcId, 106001, nodeId, index, 1] })
        } else {
            assert.equal(condition.conditionId, 2519)
            const data = base.__type_TaskCondActiveNPCTriggerData
            assert(data && data.isNowCreate && data.npcData)
            const npc = data.npcData,
                pos = { x: npc.posX, y: npc.posY, z: npc.posZ }
            assert(Object.values(pos).every(Number.isSafeInteger))
            assert(!npc.sceneId || npc.sceneId === f.state().world.map_id)
            const old = f.state().world.pos
            const distance = Math.hypot(pos.x - old.x, pos.y - old.y, pos.z - old.z) / 100
            // Model walking time, then the real current arrival-state packet;
            // no direct world-position or task-event injection is performed.
            f.advanceMs(Math.max(1, Math.ceil((distance / 4) * 1000)))
            call('StateUpdate', {
                move_msg: {
                    map_id: f.state().world.map_id,
                    move: [{ uuid: f.currentGroup().control, info: { pos, timestamp: String(f.nowMs()) } }],
                },
            })
            assert.deepEqual(f.state().world.pos, pos)
            call('ClientBehaviourRecord', { key: 2519, args: [npc.createNpcId, 106001, nodeId, index, 1] })
        }
    }
    const reachPendingCreator = () => {
        onPackets(f.login())
        assert.equal(f.state().starterProfile.mode, 'normal')
        assert.equal(f.state().player.heros_info.heros.length, 1)
        const persona = f.state().player.heros_info.heros[0]
        call('EnterWorldMap', { map_id: f.state().world.map_id })
        call('MapLoadFinish')
        for (let count = 0; count < 30; count++) {
            const node = active(),
                request = { task_id: 106001, node_id: node.node_id }
            visits.push(node.node_id)
            performActions(node.node_id, 'before')
            call('MultiTaskClientBefore', { task_params: [request] })
            const conditions = nodeConditions(graph.nodes.get(node.node_id))
            if (conditions.some((condition) => condition.conditionId === 2505)) {
                assert.equal(node.node_id, 11)
                assert(!f.state().characterCustomized)
                assert.equal(
                    f
                        .state()
                        .player.sbag_infos.items.filter((item) => item.itemid === 1000001)
                        .reduce((sum, item) => sum + item.itemnum, 0),
                    0,
                )
                call('MultiTaskClientAfter', { task_params: [request] })
                const pending = f.state().pendingCharacterTask
                assert(pending && pending.task_id === 106001 && pending.node_id === 11)
                assert.equal(pending.epoch, f.state().taskEpochs?.[106001] ?? 0)
                return { persona, pending, visits, actions }
            }
            conditions.forEach((condition, index) => completeCondition(condition, index, node.node_id))
            if (conditions.length)
                call('MultiTaskClientCondAfter', {
                    task_params: [{ ...request, indexes: conditions.map((_, index) => index) }],
                })
            performActions(node.node_id, 'after')
            call('MultiTaskClientAfter', { task_params: [request] })
            assert.notEqual(active().node_id, node.node_id)
        }
        assert.fail('current normal creator path exceeded bounded current graph steps')
    }
    return { reachPendingCreator, finishCreatorActions: () => performActions(11, 'after'), actions, visits, call }
}

export function applyCurrentHeroPackets(protocol, model, packets) {
    const enter = protocol.byName.get('CSProtoEnterGame'),
        playerSync = protocol.byName.get('CSProtoSyncPlayerData')
    for (const packet of packets) {
        let data
        if (packet.id === enter.id) {
            model.clear()
            data = protocol.decode(enter.rsp, packet.payload).data
        } else if (packet.id === playerSync.id) data = protocol.decode(playerSync.rsp, packet.payload)
        for (const hero of data?.heros_info?.heros ?? [])
            model.set(hero.guid, { ...(model.get(hero.guid) ?? {}), ...hero })
    }
}
