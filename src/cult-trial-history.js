import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Shared wire ledger is independent of the current normal raising run. Only
// the actual battle producer calls this: reset must never erase real history.
export function recordCultTrialHistory(entry, trial, result) {
    if (![1, 2, 3].includes(trial.phase) || result.star < 1) return false
    const ledger = (entry.growupArchive = structuredClone(
        entry.growupArchive ?? {
            version: 1,
            archive: [],
            history_trail_stage: 0,
            endless_max_score: '0',
            endless_max_wave: 0,
            rank_permyriad_max: 0,
            trails: [],
        },
    ))
    ensure(
        ledger.version === 1 && Array.isArray(ledger.trails),
        'Invalid cultivation history ledger',
        ErrorCode.GameConfig,
    )
    const old = ledger.trails.find((x) => x.trail_id === result.trail_id)
    if (!old || result.star > old.star || (result.star === old.star && BigInt(result.score) > BigInt(old.score)))
        ledger.trails = [...ledger.trails.filter((x) => x.trail_id !== result.trail_id), structuredClone(result)]
    ledger.history_trail_stage = Math.max(ledger.history_trail_stage ?? 0, trial.phase)
    return true
}
