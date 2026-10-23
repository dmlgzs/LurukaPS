import { isPreviousTrialActor } from './trial-groups.js'
import { ensure, group } from './common.js'
import { recordTaskBehaviour } from '../task-events.js'
import { storyCampaignSnapshot, traceStoryCampaignTask } from '../story-campaign.js'
import { endSceneTransition } from '../scene-transition.js'
import { startCultTrialBattle } from '../cult-trial.js'
import { syncLoadedNpcArena } from './kibo-duel.js'
import { updateNpcArenaPause } from '../npc-kibo-pause.js'
import { changePlayerTitle, playerTitleList } from '../player-titles.js'
export function registerClientState(on, store) {
    on('GamePause', (c, r) => {
        const gameTime = String(r.game_time ?? '0')
        if (updateNpcArenaPause(c, r))
            return { operate: c.state.world.pause.operate, game_time: c.state.world.pause.game_time }
        c.state.world.pause = { operate: !!r.operate, game_time: gameTime, updated_at: c.now }
        return { operate: !!r.operate, game_time: gameTime }
    })
    on('WorldTimeSync', (c, r) => {
        ensure(Number.isInteger(r.world_time) && r.world_time >= 0, 'Invalid world time')
        c.state.world.world_time = r.world_time
        c.state.world.world_time_updated_at = c.now
        return {}
    })
    on('MultiCampaignPlayerLoaded', (c) => {
        endSceneTransition(c.state)
        c.state.world.client_loaded = true
        c.state.world.loaded_at = c.now
        syncLoadedNpcArena(c)
        if (c.state.cultTrial?.map_id === c.state.world.map_id && [2, 3, 4].includes(c.state.cultTrial.status))
            startCultTrialBattle(c)
        const run = c.state.storyCampaign
        if (
            run?.status === 2 &&
            run.task_ids?.length &&
            run.map_id === c.state.world.map_id &&
            run.task_context_loaded_map !== run.map_id
        ) {
            // DungeonTaskRuntime.Start clears its task-sync readiness during
            // entry. Re-publish the active dungeon context after scene load,
            // so the initial trace/target is not lost before listeners exist.
            run.task_context_loaded_map = run.map_id
            const current = traceStoryCampaignTask(c.state)
            c.push('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
            c.push('CSProtoTaskSync', {
                tasks: c.state.tasks.filter((task) => run.task_ids.includes(task.task_id)),
                trace_id: current?.task_id,
                trace_list: current ? [current.task_id] : [],
                task_records: (c.state.taskRecords ?? []).filter((record) => run.task_ids.includes(record.task_id)),
            })
        }
    })
    on('SwitchGroupControlEnd', (c, r) => {
        const g = group(
            c.state,
            c.state.abyssRun?.map_id === c.state.world.map_id
                ? 7
                : c.state.cultTrial?.map_id === c.state.world.map_id
                  ? 8
                  : 1,
        )
        if (!g.heros.some((h) => h.hero_id === r.uuid) && isPreviousTrialActor(c.state, r.uuid)) return
        ensure(
            g.heros.some((h) => h.hero_id === r.uuid),
            'Control completion not in active group',
        )
        c.state.world.control_ready = r.uuid
    })
    on('ChatGetIsolateList', (c) => ({
        isolates: c.state.chatIsolation?.isolates ?? [],
        lists: c.state.chatIsolation?.lists ?? [],
    }))
    on('ClientBehaviourRecord', (c, r) => {
        ensure((r.args ?? []).length <= 64, 'Too many telemetry arguments')
        if (recordTaskBehaviour(c, r)) return {}
        const records = (c.state.clientBehaviour ??= [])
        records.push({ key: r.key ?? 0, args: r.args ?? [], time: c.now })
        if (records.length > 32) records.splice(0, records.length - 32)
        return {}
    })
    on('TitleGetList', (c) => playerTitleList(store, c.tables, c.id))
    on('TitleChange', changePlayerTitle)
    on('GetMaxArealine', (c, r) => {
        ensure(Number.isInteger(r.area_id) && r.area_id > 0, 'Invalid area')
        c.push('CSProtoMaxArealineSync', { area_id: r.area_id, max_arealine: 1 })
    })
}
