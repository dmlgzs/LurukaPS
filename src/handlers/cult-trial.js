import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { worldSync } from './world.js'
import { syncBattle } from '../battle.js'
import { cultTrialRoute, cultTrialSnapshot, ensureCultTrialScene, publishCultTrialResult } from '../cult-trial.js'
import { ensureCultFormation, publishCultFormation, clearCultFormation } from '../cult-formation.js'
import { trialPayload } from './trial-groups.js'
import { takePresentationReturn } from '../presentation-return.js'
import { selectCultArchive } from '../cult-archive-trial.js'
import { growupArchiveSnapshot } from '../growup-archive.js'
export function enterCultTrialScene(c, r = {}) {
    const run = c.state.cultTrial
    ensure(
        run && c.state.world.map_id === run.map_id && (!r.scene_id || r.scene_id === run.map_id),
        'Cultivation trial scene is not active',
    )
    ensureCultTrialScene(c.tables, c.state, c.now)
    ensureCultFormation(c.tables, c.activityCatalog, c.state, c.id)
    publishCultFormation(c)
    c.pushBefore('CSProtoCampaignInfoSync', cultTrialSnapshot(c.state, { entering: !run.archive_id }))
    worldSync({ ...c, push: c.pushBefore })
    syncBattle({ ...c, push: c.pushBefore })
    return {}
}
export function exitCultTrial(c) {
    const run = c.state.cultTrial
    ensure(run, 'No active cultivation trial')
    c.pushBefore('CSProtoCampaignInfoSync', { ...cultTrialSnapshot(c.state), status: 1 })
    const g = c.state.activities?.[run.activity_id]?.growup
    const completed = !run.archive_id && g?.cur_stage === 4 && g.cur_growup_trail_stage === 4
    const destination =
        completed && c.tables.find('world_city', run.return_world.map_id)?.type === 29
            ? takePresentationReturn(c.tables, c.state)
            : run.return_world
    Object.assign(c.state.world, destination)
    const restored = clearCultFormation(c.state)
    delete c.state.cultTrial
    delete c.state.combat
    worldSync({ ...c, push: c.pushBefore })
    c.pushBefore('CSProtoOnlineModeChange', { mode: 1 })
    syncBattle({ ...c, push: c.pushBefore })
    c.pushBefore('CSProtoTrialDatas', trialPayload(c.state))
    if (restored) c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [restored] })
    return {}
}
export function endCultTrialScene(c, r) {
    ensure(c.state.cultTrial && [1, 3, 4].includes(r.result), 'Invalid cultivation trial result')
    ensure(r.result !== 3 || c.state.cultTrial.battle_complete, 'Cultivation trial enemies are still alive')
    ensureCultTrialScene(c.tables, c.state, c.now)
    if (r.result !== 3) c.state.cultTrial.status = r.result
    if (c.state.cultTrial.archive_id && r.result === 4) c.state.cultTrial.battle_complete = true
    publishCultTrialResult(c)
    c.pushBefore('CSProtoCampaignInfoSync', cultTrialSnapshot(c.state))
    return {}
}
export function registerCultTrial(on, tables, catalog) {
    const start = (c, r, restart = false) => {
        if (restart && !r.activity_id && !r.trial_id) {
            const run = c.state.cultTrial
            ensure(run && run.map_id === c.state.world.map_id, 'No active cultivation trial to restart')
            r = { ...r, activity_id: run.activity_id, trial_id: run.trial_id, archive_id: run.archive_id }
        }
        const { row, entry } = catalog.require(c.state, c.now, r.activity_id, [60])
        ensure(!row.guideTaskId || catalog.taskDone(c.state, row.guideTaskId), 'Complete cultivation guide first')
        const { trial, route, dungeon, point } = cultTrialRoute(tables, catalog, r.activity_id, r.trial_id),
            selected = r.archive_id ? selectCultArchive(c, row, entry, r, trial) : null,
            archive = restart && c.state.cultTrial?.archive_id ? c.state.cultTrial.archive : selected,
            g = archive ? null : catalog.growup.ensure(entry, row.systemId)
        ensure(
            archive || trial.phase !== 4,
            'Endless cultivation requires a saved archive',
            ErrorCode.ActivityArchiveParamError,
        )
        ensure(
            archive ||
                (g.cur_starting_id > 0 && g.cur_stage === trial.phase && g.cur_growup_trail_stage === trial.phase),
            'Cultivation examination is not ready',
        )
        ensure(archive || catalog.growup.condition(trial.condition, g), 'Cultivation trial condition is locked')
        ensure(!c.state.entrust?.run && !c.state.storyCampaign && !c.state.multiCampaign, 'Another dungeon is active')
        const old = c.state.cultTrial
        if (old && !restart) {
            ensure(
                old.activity_id === r.activity_id &&
                    old.trial_id === r.trial_id &&
                    (old.archive_id || 0) === (r.archive_id || 0),
                'Another cultivation trial is active',
            )
            return enterCultTrialScene(c)
        }
        if (old)
            ensure(
                old.activity_id === r.activity_id && old.trial_id === r.trial_id,
                'Cannot restart another cultivation trial',
            )
        if (old) clearCultFormation(c.state)
        const w = c.state.world
        c.state.cultTrial = {
            activity_id: r.activity_id,
            trial_id: r.trial_id,
            dungeon_id: dungeon.id,
            group_id: dungeon.groupId,
            map_id: route.scene_id,
            object_ids: route.object_ids,
            ...(archive ? { archive_id: r.archive_id, archive: structuredClone(archive) } : {}),
            status: 2,
            start_time: c.now,
            instance_id: c.state.nextCultTrialInstanceId ?? 1,
            return_world: old?.return_world ?? {
                map_id: w.map_id,
                point_id: w.point_id,
                area_id: w.area_id,
                pos: { ...w.pos },
                angle: w.angle,
            },
        }
        c.state.nextCultTrialInstanceId = c.state.cultTrial.instance_id + 1
        if (g) g.select_trail_id = trial.trialId
        Object.assign(w, tables.position(point))
        ensureCultFormation(tables, catalog, c.state, c.id)
        publishCultFormation(c)
        ensureCultTrialScene(tables, c.state, c.now)
        if (archive) c.pushBefore('CSProtoSyncArchiveGrowupData', growupArchiveSnapshot(catalog, c.state, [row.id]))
        else catalog.notify(c, true)
        c.pushBefore('CSProtoCampaignInfoSync', cultTrialSnapshot(c.state))
        worldSync(
            { ...c, push: c.pushBefore },
            { campaign_start: { group_id: dungeon.groupId, difficulty: dungeon.dungeonGroupOrder } },
        )
        syncBattle({ ...c, push: c.pushBefore })
        return {}
    }
    on('EnterCultTrial', (c, r) => start(c, r))
    on('ReEnterCultTrial', (c, r) => {
        const run = c.state.cultTrial
        if (r.archive_id || run?.archive_id) {
            ensure(
                run?.archive_id && run.map_id === c.state.world.map_id,
                'No active archived cultivation trial to restart',
                ErrorCode.NotInCultTrial,
            )
            ensure(
                (!r.activity_id && !r.trial_id && !r.archive_id) ||
                    (r.activity_id === run.activity_id &&
                        r.trial_id === run.trial_id &&
                        r.archive_id === run.archive_id),
                'Cultivation restart selection differs from the active archive',
                ErrorCode.ActivityGrowUpInvalidParam,
            )
        }
        return start(c, r, true)
    })
    on('CultTrialSwitchStep', (c, r) => {
        const { row, entry } = catalog.require(c.state, c.now, r.activity_id, [60]),
            g = catalog.growup.ensure(entry, row.systemId),
            run = c.state.cultTrial
        ensure(
            !run?.archive_id,
            'Endless cultivation does not advance normal cultivation',
            ErrorCode.ActivityGrowUpInvalidStage,
        )
        const receipt = g.guid + ':' + r.trial_id
        if (
            c.state.acceptedCultTrials?.[receipt] &&
            (!run || (run.activity_id === r.activity_id && run.trial_id === r.trial_id))
        )
            return {}
        ensure(
            run?.activity_id === r.activity_id &&
                run.trial_id === r.trial_id &&
                run.battle_complete &&
                run.status === 3,
            'Cultivation trial is not successfully completed',
        )
        const { trial } = cultTrialRoute(tables, catalog, r.activity_id, r.trial_id)
        ensure(g.cur_stage === trial.phase, 'Cultivation trial does not match current phase')
        for (const change of run.attr_changes ?? []) {
            const target = g.growup_train_attr.find((x) => x.attr_id === change.attr_id)
            target.attr_value = Math.min(
                catalog.growup.config(row.systemId).maxAttr,
                target.attr_value + change.attr_value,
            )
        }
        c.state.acceptedCultTrials = { ...c.state.acceptedCultTrials, [receipt]: true }
        const finalBonus = Number(String(trial.finalscore).split('|')[run.star - 1])
        ensure(
            Number.isSafeInteger(finalBonus) && finalBonus >= 0,
            'Missing cultivation trial final score',
            ErrorCode.GameConfig,
        )
        g.final_score = String(BigInt(g.final_score ?? '0') + BigInt(finalBonus))
        if (trial.phase === 3) catalog.growup.finish(g, row.systemId, trial)
        else {
            g.cur_stage++
            g.action_count = 0
            g.cur_cost_expedition_count = catalog.growup.config(row.systemId).expeditionCount
            catalog.growup.prepare(entry, row.systemId, c.randomInt)
            c.pushBefore('CSProtoSyncGrowupTrainAssistCharData', {
                activity_id: row.id,
                starting_id: g.cur_starting_id,
                train_datas: g.assist_chars,
            })
        }
        catalog.notify(c, true)
        // OnClickExitSuccess's ACK callback calls RequestTransfer. Keep the
        // trial context until that transfer arrives rather than disposing the
        // client's ScenarioStage while it is still constructing the request.
        return {}
    })
    on('SelectCultTrial', (c, r) => {
        const { entry, row } = catalog.require(c.state, c.now, r.activity_id, [60]),
            g = catalog.growup.ensure(entry, row.systemId),
            { trial } = cultTrialRoute(tables, catalog, r.activity_id, r.trial_id)
        ensure(
            g.cur_stage === trial.phase &&
                g.cur_growup_trail_stage === trial.phase &&
                catalog.growup.condition(trial.condition, g),
            'Cultivation trial is not selectable',
        )
        g.select_trail_id = trial.trialId
        catalog.notify(c, true)
        return {}
    })
}
