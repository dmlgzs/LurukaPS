import { campaignStageSatisfied, campaignFriendlyGroupAvailable } from './campaign-stage-plan.js'
import { storyCampaignStagePlan } from './table-wave-campaign.js'
import { combatEntityStates } from './combat-enemy-lifecycle.js'

export function campaignUsesLegacySceneWaves(run) {
    return !run.task_ids?.length && !run.stage_conditions
}

// Task dungeons own their static init/controller semantics. A generic scene
// victory spawner is not a wave list for a dungeon completed by dungeon_task.
export function campaignSceneGroupPhase(tables, state, run, row, record, waves) {
    const index = waves.findIndex((entry) => entry.id === row.id)
    if (campaignUsesLegacySceneWaves(run)) {
        if (index >= 0) {
            record.active = index === (run.stage_index ?? 0)
            record.complete = index < (run.stage_index ?? 0)
            record.state_data = { ...record.state_data, step: record.complete ? 1 : 0, complete: record.complete }
        }
        return `legacy-wave:${index}`
    }
    if (!run.stage_conditions) return 'task-scene'
    const plan = storyCampaignStagePlan(tables, run),
        phase = plan.findIndex((stage) => stage.some((entry) => entry.id === row.id))
    const view = { ...state, combat: { ...state.combat, entities: combatEntityStates(state.combat) } }
    if (phase >= 0) {
        const active = phase === (run.stage_index ?? 0),
            finished = phase < (run.stage_index ?? 0)
        const complete = finished || (active && campaignStageSatisfied(tables, view, [row]))
        const pending = (plan[run.stage_index ?? 0] ?? []).filter(
            (entry) => !campaignStageSatisfied(tables, view, [entry]),
        )
        record.active = active && !complete && (!run.victory_stage_count || row.id === pending[0]?.id)
        record.complete = complete
        record.state_data = { ...record.state_data, step: complete ? 1 : 0, complete }
    } else if (campaignFriendlyGroupAvailable(tables, view, row) && !record.complete) record.active = true
    return `condition-stage:${phase}`
}
