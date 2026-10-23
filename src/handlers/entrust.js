import { captureRepeatFormation } from '../repeat-formation.js'
import { captureDungeonFavorEntry } from '../dungeon-favor-entry.js'
import { dungeonFavorRewardContext } from '../hero-favor-rewards.js'
import { claimRepeatChest, claimRepeatFirstPass } from '../repeat-event-rewards.js'
import { repeatSnapshot } from '../repeat-event.js'
import { prepareMaterialStory, beginMaterialStory, materialStoryStartPayload, materialStoryPending, replayMaterialStory } from '../multiple-material-story.js'
import { ErrorCode } from '../error-codes.js'
import { rewardSource } from '../reward-source.js'
import { materialDungeonSnapshot, materialDungeonUnlocked } from '../material-dungeons.js'
import { ensure, syncPlayer } from './common.js'
import { syncBattle } from '../battle.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { spendCurrency, spend } from '../inventory.js'
import { WorldObjectCatalog } from '../world-objects.js'
import { worldSync } from './world.js'
import { enterStoryCampaignScene, endStoryCampaignScene, exitStoryCampaign } from './story-campaign.js'
import { enterCultTrialScene, exitCultTrial, endCultTrialScene } from './cult-trial.js'
import { startCultTrialBattle } from '../cult-trial.js'
import { enterAbyssScene } from './abyss-challenge.js'
import { reportNpcArenaLoadFinish } from '../npc-kibo-battle.js'
import {
    getEntrustCatalog,
    entrustInfoSnapshot,
    entrustStarRewardSnapshot,
    entrustVictoryComplete,
    ensureEntrustSceneObjects,
    entrustMultiSnapshot,
    entrustMultiBaseSnapshot,
    entrustChestSnapshot,
    entrustChestGivenUp,
    entrustDamageSnapshot,
    campaignSnapshot,
} from '../entrust.js'

function isSingleEntrust(c) {
    return getEntrustCatalog(c.tables).get(c.state.entrust.run.entrust_id).city.type === 2
}

function unlocked(rule, state) {
    if (!rule) return true
    return String(rule)
        .split('|')
        .every((part) => {
            const [kind, id, stars, ...extra] = part.split('#').map(Number)
            if (extra.length) return false
            if (kind === 2004) return state.player.basic_info.lv >= id
            if (kind === 2007) return (state.taskRecords ?? []).some((task) => task.task_id === id && task.count > 0)
            if (kind === 13044) return (state.entrust?.records?.[id]?.entrust_star ?? 0) >= stars
            return false
        })
}

function claimEntrustChest(c, times = 1) {
    ensure(Number.isSafeInteger(times) && times > 0 && times <= 0xffffffff, 'Invalid entrust claim multiplier')
    const run = c.state.entrust?.run
    if (run?.kind === 'repeat') {
        const result = claimRepeatChest(c, times)
        c.repeatExtraRewards = result.extra
        syncPlayer({ ...c, push: c.pushBefore })
        syncEntrustStage(c)
        return result.rewards
    }
    ensure(run?.battle_complete && run.map_id === c.state.world.map_id, 'Entrust battle is not finished')
    ensure(!entrustChestGivenUp(c.tables, run), 'Stamina chest was given up', ErrorCode.StaminaBoxNotExist)
    if (run.chest_claimed) return []
    const catalog = getEntrustCatalog(c.tables),
        chest = catalog.chest(run.entrust_id)
    // Fixed recipients come only from the genuinely captured entry, even when
    // type12 players change their current formation before claiming.
    const personalFavor = dungeonFavorRewardContext(c.tables, c.state, 'dungeon-chest')
    ensure(c.now <= (run.chest_ready_time ?? run.end_time) + chest.time, 'Entrust chest expired')
    ensure(times === 1 || chest.multimes === 1, 'Chest does not support multiple claims')
    for (const cost of parseRewards(chest.need)) {
        cost.itemnum *= times
        ensure(Number.isSafeInteger(cost.itemnum) && cost.itemnum <= 0xffffffff, 'Invalid chest cost')
        if (cost.itemtype === 10) spendCurrency(c.state, cost.itemid, cost.itemnum)
        else {
            ensure(cost.itemtype === 3, 'Unsupported chest cost', ErrorCode.GameConfig)
            spend(c.state, new Map([[cost.itemid, cost.itemnum]]), 0, c.now)
        }
    }
    // Roll independently for each paid share, with the normal shared drop
    // budget. Costs, rewards and receipt commit atomically in dispatch.
    const drops = new WorldObjectCatalog(c.tables),
        budget = { count: 0 },
        merged = new Map()
    for (let i = 0; i < times; i++) {
        ensure(i < 4096, 'Drop roll limit', ErrorCode.GameConfig)
        for (const reward of drops.drops(chest.drop, c.randomInt, budget)) {
            const key = `${reward.itemtype}:${reward.itemid}`,
                old = merged.get(key)
            if (old) old.itemnum += reward.itemnum
            else merged.set(key, { ...reward })
        }
        if (run.kind === 'material') {
            // The material row specifies the three challenge bonus drop IDs.
            // Pay them with the stamina-funded share, never from a win report.
            // TODO: confirm bonus repetition/multipliers against an official
            // settlement; current behavior follows the per-share reward data.
            const ids = String(catalog.get(run.entrust_id).material.challengeReward || '')
                .split('|')
                .map(Number)
            for (let star = 0; star < ids.length; star++) {
                if (!((run.star_mask >>> star) & 1)) continue
                for (const reward of drops.drops(ids[star], c.randomInt, budget)) {
                    const key = `${reward.itemtype}:${reward.itemid}`,
                        old = merged.get(key)
                    if (old) old.itemnum += reward.itemnum
                    else merged.set(key, { ...reward })
                }
            }
        }
    }
    const rewards = [...merged.values()],
        exp = catalog.get(run.entrust_id).dungeon.userExp
    // Material chest pools already include player XP through nested drops.
    if (run.kind !== 'material' && exp > 0) rewards.push({ itemtype: 10, itemid: 10, itemnum: exp * times })
    run.rewards = grantRewards(c.tables, c.state, rewards, 0, { personalFavor })
    run.chest_claimed = true
    run.claim_times = times
    run.stage_index = catalog.stages(run.entrust_id).at(-1).index + 1
    if (run.kind !== 'material') c.state.entrust.records[run.entrust_id].first_reward_claimed = true
    syncPlayer({ ...c, push: c.pushBefore })
    syncEntrustStage(c)
    return run.rewards
}

function stageContext(c) {
    const run = c.state.entrust?.run
    if (!run || c.state.world.map_id !== run.map_id) return null
    const catalog = getEntrustCatalog(c.tables)
    return { run, catalog, stages: catalog.stages(run.entrust_id) }
}

export function syncEntrustStage(c, previousEnemyObjectId) {
    ensureEntrustSceneObjects(c.tables, c.state, c.now)
    // The interaction reply completes the marker/chest locally. Publish the
    // next wave only after that reply so the client cannot apply the old
    // marker state after the new world-object snapshot.
    syncEntrust({ ...c, pushBefore: c.push }, c.state.entrust.run)
    // WMCT_DYNAMIC_REFRESH updates objects inside the loaded dungeon without
    // running a second scene-entry flow.
    c.push('CSProtoOnlineModeChange', { mode: isSingleEntrust(c) ? 5 : 4 })
    c.push('CSProtoWorldMapSync', {
        cmd: 47,
        creator_id: c.id,
        map_id: c.state.world.map_id,
        map_info: { creator_id: c.id, map_id: c.state.world.map_id, objs: c.state.entrust.run.scene_objects },
    })
    syncEntrustEnemyBattle(c, previousEnemyObjectId)
}

export function syncEntrustEnemyBattle(c, previousEnemyObjectId) {
    const run = c.state.entrust?.run
    if (!run || run.map_id !== c.state.world.map_id || c.state.combat?.map_id !== run.map_id) return
    const groupAgent = (objectId) => ((3n << 56n) | BigInt(objectId)).toString()
    const single = isSingleEntrust(c)
    if (previousEnemyObjectId && !single) {
        const agent_uid = groupAgent(previousEnemyObjectId)
        c.push('SCProtoControlChangeByDelNtf', { agent_uid })
        c.push('SCProtoObjDisappearNtf', { agent_uid })
    }
    const enemies = Object.values(c.state.combat.entities ?? {}).filter(
        (enemy) => c.state.worldObjects?.[`${run.map_id}:${enemy.object_id}`]?.active,
    )
    for (const objectId of single ? [] : new Set(enemies.map((enemy) => enemy.object_id))) {
        const agent_uid = groupAgent(objectId)
        // Static groups already have their members in WorldObj.battle_group.
        // Appear registers the group AOI record and removes preload hide 300;
        // ownership must follow it so MapService can resolve that record.
        c.push('SCProtoObjAppearNtf', {
            agent_uid,
            agent_type: 4,
            obj: { obj_id: objectId, obj_type: 3 },
            lv: enemies.find((enemy) => enemy.object_id === objectId).level,
        })
        c.push('SCProtoControlChangeByAddNtf', { agent_uid, cli_data: { uuid: agent_uid } })
    }
    if (!single && run.battle_complete && !run.chest_claimed && !entrustChestGivenUp(c.tables, run)) {
        const chest = getEntrustCatalog(c.tables).chest(run.entrust_id)
        c.push('SCProtoObjAppearNtf', {
            agent_uid: ((8n << 56n) | BigInt(chest.worldmapid)).toString(),
            agent_type: 9,
            obj: { obj_id: chest.worldmapid, obj_type: 0 },
        })
    }
    const infos = enemies.map((enemy) => ({
        uuid: enemy.uuid,
        hp: enemy.hp,
        sp: enemy.sp ?? 0,
        alive_state: enemy.alive_state ?? (enemy.hp > 0 ? 0 : 1),
        reason: 1,
    }))
    if (infos.length) c.push('CSProtoObjBattleInfoSync', { infos })
}

export function validateEntrustObjectInteraction(c, objectId, completing) {
    if (!completing) return
    const context = stageContext(c)
    if (!context) return
    const stage = context.stages.find((entry) => entry.row.id === objectId)
    if (!stage) return
    ensure(stage.index <= context.run.stage_index, 'Entrust stage is not active')
    if (stage.type === 50 && stage.index === context.run.stage_index)
        ensure(
            context.catalog.victoryObjects(context.run.entrust_id).find((entry) => entry.objectId === objectId)?.count >
                0 &&
                Object.values(c.state.combat?.entities ?? {}).filter(
                    (enemy) => enemy.object_id === objectId && enemy.hp === 0,
                ).length ===
                    String(c.tables.find('world_enemy_group', stage.row.expandId)?.enemyList ?? '')
                        .split('|')
                        .filter(Boolean).length,
            'Entrust enemy group is still alive',
        )
}

export function completeEntrustObject(c, objectId, completing) {
    if (!completing) return []
    const context = stageContext(c)
    if (!context) return []
    const { run, stages } = context
    const position = stages.findIndex((entry) => entry.row.id === objectId)
    if (position < 0 || stages[position].index !== run.stage_index) return []
    const stage = stages[position]
    if (stage.type === 13) {
        if (prepareMaterialStory(c)) {
            syncEntrustStage(c)
            return []
        }
        run.stage_index = stages[position + 1].index
        run.battle_start_time = c.now
        run.real_start_time = c.now
        syncEntrustStage(c)
        return []
    }
    if (stage.type !== 30) return []
    ensure(
        position === stages.length - 1 && entrustVictoryComplete(context.catalog, c.state, run.entrust_id),
        'Entrust battle is not finished',
    )
    const rewards = claimEntrustChest(c)
    return [...rewards, ...(c.repeatExtraRewards ?? [])]
}

export function advanceEntrustCombat(c) {
    const context = stageContext(c)
    if (!context || context.run.status !== 2 || materialStoryPending(context.run)) return false
    const { run, stages } = context
    const position = stages.findIndex((entry) => entry.index === run.stage_index)
    const stage = stages[position]
    if (!stage || stage.type !== 50) return false
    const group = c.tables.find('world_enemy_group', stage.row.expandId),
        count = String(group?.enemyList ?? '')
            .split('|')
            .filter(Boolean).length
    if (
        !count ||
        !Array.from({ length: count }, (_, slot) =>
            ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(stage.row.id)).toString(),
        ).every((uid) => c.state.combat?.entities?.[uid]?.hp === 0)
    )
        return false
    // Battle reports share untouched world records. Fork these ten-ish scene
    // objects only when a wave ends, not on each high-frequency hit.
    c.state.worldObjects = { ...c.state.worldObjects }
    for (const object of run.scene_objects ?? []) {
        const key = `${run.map_id}:${object.obj_id}`
        const value = c.state.worldObjects[key]
        if (value) c.state.worldObjects[key] = { ...value, state_data: { ...value.state_data } }
    }
    run.stage_index = stages[position + 1].index
    if (stages[position + 1].type === 30) run.end_time = c.now
    syncEntrustStage(c, stage.row.id)
    return true
}

export function syncEntrust(c, run) {
    const multi = entrustMultiSnapshot(run)
    const active = [2, 3].includes(run.status) && run.map_id === c.state.world.map_id
    if (isSingleEntrust(c)) c.pushBefore('CSProtoCampaignInfoSync', campaignSnapshot(run))
    else {
        if (active) c.pushBefore('CSProtoMultiCampaignBaseInfoSync', entrustMultiBaseSnapshot(c.state, c.id))
        c.pushBefore('CSProtoMultiCampaignInfoSync', { camp: [multi] })
        c.pushBefore('CSProtoCurMultiCampaignInfoSync', active ? multi : { ...multi, status: 1 })
    }
    c.pushBefore('SCProtoMultiCampaignPlayerDmgInfoSync', entrustDamageSnapshot(c.state, c.id))
    if (run.battle_complete) {
        if (run.kind === 'material') c.pushBefore('SCProtoDungeonMaterialInfoSync', materialDungeonSnapshot(c.state))
        else if (run.kind === 'repeat') c.pushBefore('CSProtoRepeatEventSync', repeatSnapshot(c.state, c.activityCatalog, c.now))
        else c.pushBefore('CSProtoEntrustInfoSync', entrustInfoSnapshot(c.state))
        c.pushBefore('CSProtoStaminaBoxSync', entrustChestSnapshot(c.tables, c.state))
    }
}

export function exitEntrust(c) {
    const entrust = c.state.entrust,
        run = entrust?.run
    ensure(run, 'No active entrust', ErrorCode.EntrustNotInEntrust)
    claimRepeatFirstPass(c)
    run.status = run.status === 3 ? 5 : 1
    run.end_time ??= c.now
    syncEntrust(c, run)
    // Older builds also started the unrelated single-player campaign manager.
    // Explicitly quit it; 9513 controls this commission's actual manager.
    c.pushBefore('CSProtoCampaignInfoSync', { status: 1, dungeon_id: run.dungeon_id, cur_scene_id: run.map_id })
    Object.assign(c.state.world, run.return_world)
    delete c.state.combat
    delete entrust.run
    worldSync({ ...c, push: c.pushBefore })
    const returnType = c.tables.find('world_city', c.state.world.map_id)?.type
    c.pushBefore('CSProtoOnlineModeChange', { mode: returnType === 4 ? 2 : [2, 13].includes(returnType) ? 5 : 1 })
    syncBattle({ ...c, push: c.pushBefore })
    return {}
}

export function startEntrust(c, id, restart = false, kind = 'entrust') {
    const tables = c.tables,
        catalog = getEntrustCatalog(tables)
    const config = catalog.get(id),
        active = c.state.entrust?.run
    ensure((kind === 'material') === !!config.material && (kind === 'repeat') === !!config.repeat, 'Dungeon entry type does not match configuration')
    ensure(
        kind === 'material'
            ? materialDungeonUnlocked(config.entrust.taskUnlock, c.state)
            : unlocked(config.entrust.taskUnlock, c.state),
        'Dungeon is locked',
        ErrorCode.EntrustUnlock,
    )
    ensure(!c.state.multiCampaign && !c.state.storyCampaign && !c.state.cultTrial, 'Another dungeon is active')
    ensure(
        !active ||
            (restart && active.entrust_id === id && (kind === 'repeat' ? [1, 2, 3, 4] : [2, 3]).includes(active.status)),
        'Another entrust is active',
    )
    const entrust = (c.state.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 })
    {
        const w = c.state.world
        // Enter/ReEnter always starts a new challenge. Only login/load
        // resumes an existing run; historical stars never restore a box.
        if (entrust.records[id]) delete entrust.records[id].pending_chest
        const run = {
            ...(kind !== 'entrust' ? { kind } : {}),
            entrust_id: id,
            dungeon_id: config.dungeon.id,
            map_id: config.scene.id,
            instance_id: entrust.nextInstanceId++,
            status: 2,
            star: 0,
            hero_deaths: 0,
            damage_total: '0',
            start_time: c.now,
            return_world: active?.return_world ?? {
                map_id: w.map_id,
                point_id: w.point_id,
                area_id: w.area_id,
                pos: { ...w.pos },
                angle: w.angle,
            },
        }
        entrust.run = run
        Object.assign(w, tables.position(config.point))
        delete c.state.combat
        for (const key of Object.keys(c.state.worldObjects ?? {}))
            if (key.startsWith(`${run.map_id}:`)) delete c.state.worldObjects[key]
    }
    ensureEntrustSceneObjects(tables, c.state, c.now)
    c.pushBefore('CSProtoCurMultiCampaignInfoSync', { status: 1, dungeon_id: entrust.run.dungeon_id })
    syncEntrust(c, entrust.run)
    worldSync({ ...c, push: c.pushBefore }, {}, active ? 49 : 256, false)
    // Capture after worldSync restores an expired story/home trial formation.
    if (kind === 'repeat') entrust.run.repeat_formation = captureRepeatFormation(c.state, entrust.run, c.now)
    else entrust.run.favor_entry = captureDungeonFavorEntry(tables, c.state, entrust.run, c.now)
    syncBattle({ ...c, push: c.pushBefore })
    return {}
}

export function startMaterialDungeon(c, r) {
    ensure(
        r.scene_type === 12 && !r.dungeon_site && !r.stage_id,
        'Unsupported material dungeon entry parameters',
        ErrorCode.FunctionClosed,
    )
    const rows = c.tables.get('dungeon_material').filter((row) => row.dungeonId === r.dungeon_id)
    ensure(rows.length === 1, 'Material dungeon configuration unavailable', ErrorCode.DungeonConfNotExist)
    return startEntrust(c, rows[0].id, false, 'material')
}

export function registerEntrust(on, tables) {
    const catalog = getEntrustCatalog(tables)
    const sync = syncEntrust
    const start = (c, id, restart = false) => startEntrust(c, id, restart)

    on('EnterEntrust', (c, r) => start(c, r.entrust_id))
    on('ReEnterEntrust', (c, r) => start(c, r.entrust_id, true))
    on('EnterDungeonScene', (c, r) => {
        if (c.state.abyssRun) return enterAbyssScene(c, r)
        if (c.state.cultTrial) return enterCultTrialScene(c, r)
        if (c.state.storyCampaign) return enterStoryCampaignScene(c, r)
        const run = c.state.entrust?.run
        ensure(
            run && [2, 3].includes(run.status) && (!r.scene_id || r.scene_id === run.map_id),
            'Entrust scene is not active',
            ErrorCode.EntrustMapInvalid,
        )
        ensure(!r.creator_id || r.creator_id === c.id, 'Entrust creator mismatch')
        ensureEntrustSceneObjects(tables, c.state, c.now)
        sync(c, run)
        worldSync({ ...c, push: c.pushBefore }, {}, 256, false)
        return {}
    })
    on('MultiCampaignPlayerLoadFinish', (c) => {
        if (c.state.combat?.npcDuel && c.state.multiCampaign?.map_id === c.state.world.map_id) {
            reportNpcArenaLoadFinish(c)
            c.pushBefore('CSProtoMultiCampaignPlayerLoadingPageCompleteNtf', { u32: c.id })
            return
        }
        if (c.state.cultTrial) {
            c.pushBefore('CSProtoMultiCampaignPlayerLoadingPageCompleteNtf', { u32: c.id })
            startCultTrialBattle(c)
            return
        }
        const run = c.state.entrust?.run
        if (!run) {
            ensure(
                c.state.multiCampaign && c.state.world.map_id === c.state.multiCampaign.map_id,
                'No active dungeon loading',
            )
            c.pushBefore('CSProtoMultiCampaignPlayerLoadingPageCompleteNtf', { u32: c.id })
            return
        }
        ensure([2, 3].includes(run.status) && c.state.world.map_id === run.map_id, 'No active entrust loading')
        ensureEntrustSceneObjects(tables, c.state, c.now)
        run.loading_complete_at ??= c.now
        sync(c, run)
        c.pushBefore('CSProtoMultiCampaignPlayerLoadingPageCompleteNtf', { u32: c.id })
        // Keep the dungeon's AOI/preload mode and give this local client
        // ownership of the active group through the normal control protocol.
        c.push('CSProtoOnlineModeChange', { mode: isSingleEntrust(c) ? 5 : 4 })
        syncEntrustEnemyBattle(c)
        replayMaterialStory(c)
    })
    on('EndDungeonScene', (c, r) => {
        if (c.state.cultTrial) return endCultTrialScene(c, r)
        if (c.state.storyCampaign) return endStoryCampaignScene(c, r)
        const entrust = c.state.entrust,
            run = entrust?.run
        ensure(run && [2, 3].includes(run.status), 'No active entrust', ErrorCode.EntrustNotInEntrust)
        if (run.status === 3) {
            claimRepeatFirstPass(c)
            return {}
        }
        ensure([1, 3, 4].includes(r.result), 'Invalid entrust result')
        if (r.result === 3) {
            ensureEntrustSceneObjects(tables, c.state)
            ensure(entrustVictoryComplete(catalog, c.state, run.entrust_id), 'Entrust enemies are not defeated')
            // Combat unlocks the chest. Its 9133 interaction delivers the
            // reward and star; a 9507 victory report alone cannot claim it.
            ensure(stageContext(c).stages.at(-1).index === run.stage_index, 'Entrust chest is not ready')
            run.end_time ??= c.now
        } else {
            run.status = r.result
            run.end_time = c.now
        }
        sync(c, run)
        return {}
    })
    on('CampaignQuit', (c) =>
        c.state.cultTrial ? exitCultTrial(c) : c.state.storyCampaign ? exitStoryCampaign(c) : exitEntrust(c),
    )
    on('StaminaBoxGet', (c, r) => {
        const run = c.state.entrust?.run
        ensure(run && r.box_id === catalog.chest(run.entrust_id).id, 'Invalid entrust chest claim')
        ensureEntrustSceneObjects(tables, c.state)
        return {
            reward: { rewards: claimEntrustChest(c, r.times), src: rewardSource(c.tables, 'staminaChest') },
            extra_reward: { rewards: c.repeatExtraRewards ?? [], src: rewardSource(c.tables, 'staminaChest') },
        }
    })
    on('StaminaBoxGiveUp', (c, r) => {
        ensure(
            Number.isInteger(r.box_id) && r.box_id > 0 && r.box_id <= 0xffffffff,
            'Invalid stamina chest identity',
            ErrorCode.InvalidArgument,
        )
        const run = c.state.entrust?.run
        ensure(run, 'Stamina chest does not exist', ErrorCode.StaminaBoxNotExist)
        // pageDungeonReward sends 9976 only for MaterialDungeon/WeeklyBoss.
        // Weekly runs have no supported ledger yet; normal commission dialog
        // cancellation uses a different local event and must not enter here.
        ensure(run.kind === 'material', 'Unsupported stamina chest give-up mode', ErrorCode.FunctionClosed)
        ensure(run.map_id === c.state.world.map_id, 'Not in stamina chest map', ErrorCode.NotInMap)
        const chest = catalog.chest(run.entrust_id)
        ensure(r.box_id === chest.id, 'Stamina chest does not exist', ErrorCode.StaminaBoxNotExist)
        ensure(run.battle_complete && !run.chest_claimed, 'No unclaimed stamina chest', ErrorCode.StaminaBoxNotExist)
        if (!entrustChestGivenUp(c.tables, run)) {
            ensure(
                Number.isSafeInteger(run.instance_id) &&
                    run.instance_id > 0 &&
                    Number.isSafeInteger(c.now) &&
                    c.now >= 0,
                'Invalid stamina chest instance',
                ErrorCode.GameConfig,
            )
            ensure(
                Number.isSafeInteger(run.chest_ready_time ?? run.end_time) &&
                    Number.isSafeInteger(chest.time) &&
                    chest.time > 0,
                'Invalid stamina chest deadline',
                ErrorCode.GameConfig,
            )
            ensure(
                c.now < (run.chest_ready_time ?? run.end_time) + chest.time,
                'Stamina chest expired',
                ErrorCode.StaminaBoxExpired,
            )
            run.chest_given_up = { instance_id: run.instance_id, box_id: chest.id, at: c.now }
            run.stage_index = catalog.stages(run.entrust_id).at(-1).index + 1
        } else
            ensure(
                run.chest_given_up.box_id === chest.id,
                'Stamina chest give-up identity mismatch',
                ErrorCode.GameConfig,
            )
        // No reward path, cost, claim count or scene exit. A zero finish_time
        // makes StaminaChestData.GetIsAlive false; refresh only this run's box.
        syncEntrustStage(c)
        return {}
    })
    on('EntrustStarReward', (c, r) => {
        const ids = [...new Set([r.reward_id, ...(r.reward_id_list ?? [])].filter(Boolean))]
        ensure(ids.length > 0 && ids.length <= 64, 'Invalid entrust reward selection')
        const entrust = (c.state.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }),
            rewards = []
        for (const id of ids) {
            const row = tables.find('dungeon_entrust_reward', id)
            ensure(row, 'Entrust star reward unavailable', ErrorCode.EntrustStarConfigNone)
            ensure(
                row.dungeonEntrustType === 1,
                'Entrust reward belongs to another mode',
                ErrorCode.EntrustStarConfigNone,
            )
            const total = Object.values(entrust.records).reduce(
                (sum, record) => sum + (record.group_id === row.dungeonEntrustGroup ? record.entrust_star : 0),
                0,
            )
            ensure(total >= row.starNum, 'Entrust star requirement not reached', ErrorCode.EntrustStarNotReached)
            ensure(!entrust.starRewards[id], 'Entrust star reward already claimed', ErrorCode.EntrustStarAlready)
            rewards.push(
                ...grantRewards(
                    tables,
                    c.state,
                    String(row.reward)
                        .split('|')
                        .map((item) => {
                            const [itemtype, itemid, itemnum] = item.split('#').map(Number)
                            return { itemtype, itemid, itemnum }
                        }),
                ),
            )
            entrust.starRewards[id] = { reward_id: id, reward_time: c.now }
        }
        syncPlayer({ ...c, push: c.pushBefore })
        c.pushBefore('CSProtoEntrustStarRewardSync', entrustStarRewardSnapshot(c.state))
        return { rewards }
    })
}

export function beginMaterialStoryInteraction(c, objectId) {
    if (!beginMaterialStory(c, objectId)) return false
    const run = c.state.entrust.run
    ensureEntrustSceneObjects(c.tables, c.state, c.now)
    syncEntrust({ ...c, pushBefore: c.push }, run)
    worldSync(c, {}, 19, false)
    c.push('SCProtoPlayerStoryStart', materialStoryStartPayload(run.materialStory))
    return true
}
