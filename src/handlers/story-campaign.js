import { resetCampaignPlayableEntry } from '../campaign-playable-ledger.js'
import { localCampaignSatisfied } from '../campaign-playable-route.js'
import { registerTeaching } from './teaching.js'
import { ErrorCode } from '../error-codes.js'
import { visibleEnemySlots } from '../enemy-group-visibility.js'
import { storyCampaignStagePlan } from '../table-wave-campaign.js'
import { ensure } from './common.js'
import { campaignStageSatisfied } from '../campaign-stage-plan.js'
import { teachingSceneKillReady } from '../teaching-kill-conditions.js'
import { teachingSceneVictory } from '../teaching-scene-victory.js'
import { syncBattle } from '../battle.js'
import { finishEnemyGroupRelations, pruneInactiveCampaignRelations } from './world-combat.js'
import { inactiveCampaignEnemyGroup } from '../inactive-campaign-enemies.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { worldSync } from './world.js'
import { TaskGraphs, nodeConditions, acceptTask, taskSnapshot, reconcileClearedDungeonBefore } from '../tasks.js'
import {
    storyCampaignConfig,
    storyCampaignSnapshot,
    ensureStoryCampaignScene,
    storySceneDefeated,
    campaignEntryTasks,
    storyCampaignReturnWorld,
    resetCampaignTasks,
} from '../story-campaign.js'
import { playableSnapshot } from './playable-lifecycle.js'

export function syncStoryCampaignEnemies(c) {
    const run = c.state.storyCampaign
    if (c.state.combat?.map_id !== run?.map_id) return
    const infos = Object.values(c.state.combat.entities ?? {})
        .filter(
            (enemy) =>
                !inactiveCampaignEnemyGroup(c.tables, c.state, enemy.uuid) &&
                !(run.stage_conditions && c.state.worldObjects?.[run.map_id + ':' + enemy.object_id]?.active === false),
        )
        .map((enemy) => ({
            uuid: enemy.uuid,
            hp: enemy.hp,
            sp: enemy.sp ?? 0,
            alive_state: enemy.alive_state ?? (enemy.hp > 0 ? 0 : 1),
            reason: 1,
            ...(enemy.final_blow_guid ? { final_blow_guid: enemy.final_blow_guid } : {}),
        }))
    if (infos.length) c.pushBefore('CSProtoObjBattleInfoSync', { infos })
    pruneInactiveCampaignRelations({ ...c, push: c.pushBefore })
    // Loading recovery uses the same all-slots proof as the death event.
    for (const enemy of Object.values(c.state.combat.entities ?? {}))
        if (enemy.hp === 0 && enemy.alive_state === 1)
            finishEnemyGroupRelations({ ...c, push: c.pushBefore }, enemy.uuid)
}

export function enterStoryCampaignScene(c, r) {
    const run = c.state.storyCampaign
    const requestedScene = r.scene_id || run?.map_id
    ensure(
        run?.status === 2 && run.scenes.includes(requestedScene),
        'Story dungeon is not active',
        ErrorCode.EntrustMapInvalid,
    )
    ensure(!r.creator_id || r.creator_id === c.id, 'Dungeon creator mismatch')
    if (requestedScene !== run.map_id) {
        ensure(
            run.completed_scenes.includes(run.map_id) &&
                run.scenes.indexOf(requestedScene) === run.scenes.indexOf(run.map_id) + 1,
            'Previous story dungeon scene is not complete',
        )
        run.map_id = requestedScene
        run.stage_index = 0
        const config = storyCampaignConfig(c.tables, run.group_id, run.difficulty)
        Object.assign(
            c.state.world,
            c.tables.position(config.scenes.find(({ scene }) => scene.id === requestedScene).point),
        )
        delete c.state.combat
    }
    ensureStoryCampaignScene(c.tables, c.state, c.now)
    c.pushBefore('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
    worldSync({ ...c, push: c.pushBefore }, {}, 256, false)
    syncBattle({ ...c, push: c.pushBefore })
    syncStoryCampaignEnemies(c)
    return {}
}

export function settleStoryCampaignScene(c) {
    const run = c.state.storyCampaign
    if (run?.local_playable_condition) return settlePlayableCampaign(c)
    if (run?.task_ids?.length) return false // This variant is completed by its dungeon_task chain, not wave deaths.
    if (!run || run.status !== 2 || run.completed_scenes.includes(run.map_id) || c.state.combat?.map_id !== run.map_id)
        return false
    if (run.stage_conditions) {
        const plan = storyCampaignStagePlan(c.tables, run),
            before = run.stage_index ?? 0
        const objectCompleted = (plan[before] ?? []).some(
            (row) =>
                !c.state.worldObjects?.[run.map_id + ':' + row.id]?.complete &&
                campaignStageSatisfied(c.tables, c.state, [row]),
        )
        while (
            (run.stage_index ?? 0) < plan.length &&
            campaignStageSatisfied(c.tables, c.state, plan[run.stage_index ?? 0])
        )
            run.stage_index = (run.stage_index ?? 0) + 1
        if ((run.stage_index ?? 0) === before && !objectCompleted) return false
        if (run.stage_index === plan.length && !run.completed_scenes.includes(run.map_id))
            run.completed_scenes.push(run.map_id)
        ensureStoryCampaignScene(c.tables, c.state, c.now)
        // CBT3 DungeonPlayingManager dispatches the victory graph on state 3.
        // The final scene status alone cannot start its ending story.
        if (
            run.map_id === run.scenes.at(-1) &&
            run.scenes.every((id) => run.completed_scenes.includes(id)) &&
            storySceneDefeated(c.tables, c.state)
        ) {
            run.status = 3
            run.end_time = c.now
            creditStoryCampaign(c, run.dungeon_id)
        }
        c.push('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
        c.push('CSProtoWorldMapSync', {
            cmd: 47,
            creator_id: c.id,
            map_id: run.map_id,
            map_info: {
                creator_id: c.id,
                map_id: run.map_id,
                objs:
                    storyCampaignSnapshot(c.state).scene_datas.find((scene) => scene.scene_id === run.map_id)?.objs ??
                    run.scene_objects.map(({ claims, ...obj }) => obj),
            },
        })
        return true
    }
    const scene = c.tables.find('dungeon_scene', run.map_id)
    const [kind, spawner, , , count] = run.teaching_id
        ? teachingSceneVictory(c.tables, scene)
        : String(scene?.victoryCondition).split('#').map(Number)
    const waves = c.tables
        .get(`worldmap_${run.map_id}`)
        .filter((row) => row.spawnerId === spawner)
        .sort((a, b) => a.id - b.id)
    if (kind !== 2500 || waves.length !== count) return false
    let advanced = false
    while ((run.stage_index ?? 0) < waves.length) {
        const row = waves[run.stage_index ?? 0]
        const slots = String(c.tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
            .split('|')
            .filter(Boolean)
        if (
            !slots.length ||
            !slots.every(
                (_, slot) =>
                    c.state.combat.entities[((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString()]?.hp ===
                    0,
            )
        )
            break
        run.stage_index = (run.stage_index ?? 0) + 1
        advanced = true
    }
    if (!advanced) return false
    c.state.worldObjects = { ...c.state.worldObjects }
    for (const row of c.tables.get(`worldmap_${run.map_id}`)) {
        if (c.tables.find('world_spawner', row.spawnerId)?.objectType !== 50) continue
        const key = `${run.map_id}:${row.id}`,
            old = c.state.worldObjects[key]
        if (!old) continue
        const index = waves.findIndex((entry) => entry.id === row.id)
        const complete = index < run.stage_index
        const record = {
            ...old,
            active: index === run.stage_index,
            complete,
            state_data: { ...old.state_data, step: complete ? 1 : 0, complete },
            expand_data: {
                ...old.expand_data,
                battle_group: {
                    ...old.expand_data?.battle_group,
                    monsters:
                        old.expand_data?.battle_group?.monsters?.map((monster) => ({
                            ...monster,
                            hp: c.state.combat.entities[monster.uid]?.hp ?? monster.hp,
                        })) ?? [],
                },
            },
        }
        // This legacy wave path updates HP without calling the scene builder.
        // Recompute visibility too, rather than copying the previous live list.
        record.time = run.start_time
        record.next_time = 0
        record.expand_data.battle_group.world_indexes = visibleEnemySlots(
            record.expand_data.battle_group.monsters,
            c.state.combat.entities,
        )
        c.state.worldObjects[key] = record
    }
    run.scene_objects = c.tables.get(`worldmap_${run.map_id}`).map((row) => {
        const { claims, ...object } = c.state.worldObjects[`${run.map_id}:${row.id}`]
        return object
    })
    if (run.stage_index === waves.length && storySceneDefeated(c.tables, c.state)) run.completed_scenes.push(run.map_id)
    c.push('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
    c.push('CSProtoWorldMapSync', {
        cmd: 47,
        creator_id: c.id,
        map_id: run.map_id,
        map_info: { creator_id: c.id, map_id: run.map_id, objs: run.scene_objects },
    })
    if (!run.completed_scenes.includes(run.map_id)) {
        const next = waves[run.stage_index]
        const infos = Object.values(c.state.combat.entities)
            .filter((enemy) => enemy.object_id === next.id)
            .map((enemy) => ({
                uuid: enemy.uuid,
                hp: enemy.hp,
                sp: enemy.sp ?? 0,
                alive_state: enemy.alive_state ?? 0,
                reason: 1,
            }))
        if (infos.length) c.push('CSProtoObjBattleInfoSync', { infos })
    }
    return true
}

function settlePlayableCampaign(c) {
    const run = c.state.storyCampaign
    if (run.status !== 2 || run.map_id !== c.state.world.map_id) return false
    const plan = storyCampaignStagePlan(c.tables, run), before = run.stage_index ?? 0
    while ((run.stage_index ?? 0) < plan.length && campaignStageSatisfied(c.tables, c.state, plan[run.stage_index ?? 0]))
        run.stage_index = (run.stage_index ?? 0) + 1
    const won = localCampaignSatisfied(c.tables, c.state)
    if (won) {
        run.completed_scenes = [...run.scenes]
        run.status = 3
        run.end_time = c.now
        creditStoryCampaign(c, run.dungeon_id)
    }
    if (!won && before === (run.stage_index ?? 0)) return false
    ensureStoryCampaignScene(c.tables, c.state, c.now)
    c.push('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
    c.push('CSProtoWorldMapSync', { cmd: 47, creator_id: c.id, map_id: run.map_id,
        map_info: { creator_id: c.id, map_id: run.map_id, objs: storyCampaignSnapshot(c.state).scene_datas[0].objs } })
    return true
}

function creditStoryCampaign(c, dungeonId) {
    const teaching = c.state.storyCampaign?.teaching_id
    if (teaching) {
        const records = (c.state.teachingRecords ??= [])
        if (records.includes(teaching)) return false
        const train = c.tables.get('train_task').find((row) => row.taskid === teaching)
        ensure(train, 'Unknown teaching task', ErrorCode.TrainTaskConfNone)
        c.state.storyCampaign.rewards = grantRewards(c.tables, c.state, parseRewards(train.passReward))
        records.push(teaching)
        c.pushBefore('CSProtoTeachInfoSync', { u32s: records })
        c.pushBefore('CSProtoSyncPlayerData', c.state.player)
        return true
    }
    const clears = (c.state.storyCampaignClears ??= {})
    const existing = clears[dungeonId]
    const clear = (clears[dungeonId] ??= { count: 1, time: c.now })
    const mapping = c.tables.get('dungeon_task').find((row) => row.dungeonId === dungeonId)
    const ids = String(mapping?.taskIds ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    const [kind, victoryTask] = String(c.tables.find('dungeon', dungeonId)?.victoryCondition ?? '')
        .split('#')
        .map(Number)
    if (
        !clear.task_proof &&
        kind === 2007 &&
        ids.length &&
        ids.at(-1) === victoryTask &&
        ids.every((id) => (c.state.taskRecords ?? []).some((record) => record.task_id === id && record.count > 0))
    )
        clear.task_proof = { victory_task_id: victoryTask, task_ids: ids }
    const graphs = new TaskGraphs(c.tables)
    for (const task of campaignEntryTasks(c.tables, c.state, dungeonId))
        for (const node of task.nodes) reconcileClearedDungeonBefore(c.tables, graphs.get(task.task_id), node, c.state)
    if (existing) return false
    const exp = c.tables.find('dungeon', dungeonId)?.userExp
    if (exp > 0) {
        const rewards = grantRewards(c.tables, c.state, [{ itemtype: 10, itemid: 10, itemnum: exp }])
        if (c.state.storyCampaign) c.state.storyCampaign.rewards = rewards
        c.pushBefore?.('CSProtoSyncPlayerData', { basic_info: c.state.player.basic_info })
    }
    return true
}

export function recoverStoryCampaignClear(c) {
    if (c.state.storyCampaignClears?.[10010]) return false
    const task = c.state.tasks?.find((entry) => entry.task_id === 106014)
    if (!task?.nodes.some((node) => node.node_id === 11)) return false
    const scene = c.tables.find('dungeon_scene', 6200)
    const [kind, spawner, , , count] = String(scene?.victoryCondition).split('#').map(Number)
    const groups = c.tables.get('worldmap_6200').filter((row) => row.spawnerId === spawner)
    if (
        kind !== 2500 ||
        groups.length !== count ||
        !groups.every((row) => {
            const saved = c.state.worldObjects?.[`6200:${row.id}`]
            const expected = String(c.tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
                .split('|')
                .filter(Boolean).length
            return (
                saved?.complete &&
                saved.state_data?.step === 1 &&
                saved.expand_data?.battle_group?.monsters?.length === expected &&
                saved.expand_data.battle_group.monsters.every((monster) => monster.hp === 0)
            )
        })
    )
        return false
    return creditStoryCampaign(c, 10010)
}

export function endStoryCampaignScene(c, r) {
    const run = c.state.storyCampaign
    ensure(
        (run?.status === 2 || (run?.status === 3 && r.result === 3)) && c.state.world.map_id === run.map_id,
        'No active story dungeon',
    )
    ensure([1, 3, 4].includes(r.result), 'Invalid dungeon result')
    if (r.result === 3) {
        if (
            run.teaching_id &&
            !storySceneDefeated(c.tables, c.state) &&
            teachingSceneKillReady(c.tables, c.state, c.now)
        ) {
            // The teaching challenge can report success before its FSM's
            // delayed StoryKillReq. ACK this verified intent, but do not grant
            // a clear or allow the next scene until the configured kill arrives.
            run.pending_end_scene = run.map_id
            return {}
        }
        ensure(
            run.task_ids?.length ? storySceneDefeated(c.tables, c.state) : run.completed_scenes.includes(run.map_id),
            'Story dungeon enemies are not defeated',
        )
        if ((!run.stage_conditions && !run.teaching_id) || run.map_id === run.scenes.at(-1)) {
            run.status = 3
            run.end_time = c.now
            creditStoryCampaign(c, run.dungeon_id)
        }
    } else {
        run.status = r.result
        run.end_time = c.now
    }
    c.pushBefore('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
    return {}
}

export function exitStoryCampaign(c) {
    const run = c.state.storyCampaign
    ensure(run, 'No active story dungeon', ErrorCode.EntrustNotInEntrust)
    if (
        run.status === 2 &&
        ((!run.stage_conditions && !run.teaching_id) || run.map_id === run.scenes.at(-1)) &&
        run.completed_scenes.includes(run.map_id) &&
        storySceneDefeated(c.tables, c.state)
    ) {
        run.status = 3
        run.end_time = c.now
        creditStoryCampaign(c, run.dungeon_id)
        c.pushBefore('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
    }
    const final = run.status === 3 ? 5 : 1
    c.pushBefore('CSProtoCampaignInfoSync', { ...storyCampaignSnapshot(c.state), status: final })
    Object.assign(c.state.world, storyCampaignReturnWorld(c.tables, c.state, run))
    // An activity guide can explicitly wait for a configured exterior scene
    // after its dungeon condition. Respect that return point only after a
    // verified clear; a manual/failed exit still returns to its entrance.
    if (run.status === 3) {
        const point = c.activityCatalog?.guideReturnPoint(c.state, c.now, run.dungeon_id)
        if (point) Object.assign(c.state.world, c.tables.position(point))
    }
    delete c.state.storyCampaign
    const reset = resetCampaignTasks(c.tables, c.state, run)
    if (reset) {
        c.pushBefore('CSProtoTaskSync', reset)
        c.pushBefore('CSProtoTaskSync', taskSnapshot(c.tables, c.state))
        c.pushBefore('CSProtoPlayableSync', playableSnapshot(c.state))
    }
    delete c.state.combat
    worldSync({ ...c, push: c.pushBefore })
    c.pushBefore('CSProtoOnlineModeChange', { mode: 1 })
    syncBattle({ ...c, push: c.pushBefore })
    return {}
}

export function advanceStoryCampaignTask(c, taskId) {
    const run = c.state.storyCampaign
    if (!run?.task_ids?.includes(taskId) || run.status !== 2) return
    const config = storyCampaignConfig(c.tables, run.group_id, run.difficulty)
    const nextIndex = run.task_ids.indexOf(taskId) + 1
    if (nextIndex === run.task_ids.length) {
        ensure(storySceneDefeated(c.tables, c.state), 'Dungeon victory task is incomplete')
        run.completed_scenes = [...run.scenes]
        run.status = 3
        run.end_time = c.now
        creditStoryCampaign(c, run.dungeon_id)
        c.push('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
        // autoExit is explicitly configured by dungeon_task; the client task
        // after-actions have already finished before its TaskFinish request.
        if (config.taskMapping.autoExit === 1) exitStoryCampaign(c)
        return
    }
    const nextId = run.task_ids[nextIndex]
    if (!c.state.tasks.some((task) => task.task_id === nextId))
        acceptTask(new TaskGraphs(c.tables).get(nextId), c.state, c.now).client_trace = true
    if (run.pending_task_transfer?.task_id === taskId) delete run.pending_task_transfer
    // TaskFinish acknowledges the task, not a scene transfer. Transfers run
    // through the task's configured client action and EnterWorldMap, including
    // moves to intermediate scenes and points unlike the next task checkpoint.
    c.pushBefore('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
}

export function registerStoryCampaign(on, tables) {
    registerTeaching(on, tables)
    on('CampaignCreate', (c, r) => {
        const config = storyCampaignConfig(tables, r.group_id, r.difficulty)
        const graphs = new TaskGraphs(tables)
        const requiredByTask = c.state.tasks?.some((task) =>
            task.nodes.some((node) =>
                nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id)).some(
                    (condition) =>
                        condition.__type_TaskConditionBaseData?.__type_TaskCondDungeonData?.dungeonId ===
                        config.dungeon.id,
                ),
            ),
        )
        const [unlockKind, unlockLevel] = String(config.dungeon.unlockCondition).split('#').map(Number)
        ensure(
            requiredByTask && unlockKind === 2004 && c.state.player.basic_info.lv >= unlockLevel,
            'Story dungeon task is not active',
        )
        ensure(!c.state.entrust?.run && !c.state.multiCampaign && !c.state.storyCampaign, 'Another dungeon is active')
        if (config.localPlayableRoute) {
            const next = c.state.nextStoryCampaignInstanceId ?? 1
            ensure(Number.isSafeInteger(next) && next > 0 && next < Number.MAX_SAFE_INTEGER,
                'Campaign instance counter is damaged or exhausted', ErrorCode.GameConfig)
        }
        const w = c.state.world
        const run = (c.state.storyCampaign = {
            dungeon_id: config.dungeon.id,
            group_id: r.group_id,
            difficulty: r.difficulty,
            instance_id: c.state.nextStoryCampaignInstanceId ?? 1,
            scenes: config.scenes.map(({ scene }) => scene.id),
            map_id: config.scenes[0].scene.id,
            completed_scenes: [],
            task_ids: config.taskIds,
            stage_conditions: config.stageConditions,
            victory_stage_count: config.victoryStageCount,
            ...(config.localPlayableRoute ? {
                local_playable_condition: config.localPlayableRoute.local_condition,
                playable_ids: config.localPlayableRoute.playable_ids,
                opening_story: config.localPlayableRoute.opening_stories[0],
                ending_story: config.localPlayableRoute.ending_story,
                opening_delete_tag: config.localPlayableRoute.delete_tag,
                playable_successes: {},
                next_playable_attempt: 0,
            } : {}),
            entry_tasks: config.taskIds.length
                ? structuredClone(campaignEntryTasks(tables, c.state, config.dungeon.id))
                : undefined,
            status: 2,
            start_time: c.now,
            return_world: {
                map_id: w.map_id,
                point_id: w.point_id,
                area_id: w.area_id,
                pos: { ...w.pos },
                angle: w.angle,
            },
        })
        run.return_world = storyCampaignReturnWorld(tables, c.state, run)
        resetCampaignPlayableEntry(c.state, run)
        if (config.taskIds.length) {
            c.pushBefore('CSProtoTaskSync', {
                del_tasks: config.taskIds,
                del_task_records: config.taskIds,
                del_trace_list: config.taskIds,
            })
            // A fresh run replays its internal task chain. Main story receipts
            // and rewards remain independent from these dungeon-only tasks.
            c.state.tasks = c.state.tasks.filter((task) => !config.taskIds.includes(task.task_id))
            c.state.taskRecords = (c.state.taskRecords ?? []).filter((task) => !config.taskIds.includes(task.task_id))
            for (const taskId of config.taskIds)
                for (const node of graphs.get(taskId).nodes.values())
                    for (const condition of nodeConditions(node)) {
                        const playableId =
                            condition.__type_TaskConditionBaseData?.__type_TaskCondPlayableIsFinishData?.playableID
                        if (playableId) {
                            delete c.state.playableFinishes?.[playableId]
                            delete c.state.playableRuns?.[playableId]
                        }
                    }
            acceptTask(graphs.get(config.taskIds[0]), c.state, c.now).client_trace = true
            c.push('CSProtoTaskSync', { ...taskSnapshot(tables, c.state), new_task_ids: [config.taskIds[0]] })
        }
        c.state.nextStoryCampaignInstanceId = run.instance_id + 1
        Object.assign(w, tables.position(config.scenes[0].point))
        ensureStoryCampaignScene(tables, c.state, c.now)
        if (run.local_playable_condition) c.pushBefore('CSProtoPlayableSync', playableSnapshot(c.state))
        c.pushBefore('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
        worldSync(
            { ...c, push: c.pushBefore },
            {
                campaign_start: {
                    group_id: r.group_id,
                    difficulty: r.difficulty,
                },
            },
            256,
            false,
        )
        syncBattle({ ...c, push: c.pushBefore })
        syncStoryCampaignEnemies(c)
        return {}
    })
}
