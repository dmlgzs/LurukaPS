import { homeCondition } from './home-grid.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

// SCHomeSync.home_lv selects home_stage scene layers. Cultivation progress
// belongs exclusively to home_level_new_base, not this two-stage selector.
export function reconcileHomeStage(tables, state) {
    if (!state.home) return false
    const stages = tables.get('home_stage')
    ensure(stages.length > 0, 'Missing home scene stages', ErrorCode.GameConfig)
    const stage = stages.reduce(
        (current, row) => (homeCondition(row.unlockCondition, state) ? Math.max(current, row.id) : current),
        0,
    )
    ensure(stage > 0, 'No unlocked home scene stage', ErrorCode.GameConfig)
    if (state.home.stage === stage && state.player.basic_info.home_lv === stage) return false
    state.home.stage = stage
    state.player.basic_info.home_lv = stage
    state.homeRevision = (state.homeRevision || 0) + 1
    return true
}
