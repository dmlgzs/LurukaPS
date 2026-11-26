import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

// Current TDGameEventsCulEnd.get_trial060259c6 is an int->int dictionary;
// Scenario.RuntimeData.Difficult selects its key, never the last tuple's value.
export function growupEndingTrial(tables, ending, difficulty) {
    ensure(uint(difficulty), 'Invalid cultivation ending difficulty', ErrorCode.GameConfig)
    ensure(
        ending &&
            uint(ending.systemId) &&
            ending.systemId > 0 &&
            uint(ending.endingId) &&
            ending.endingId > 0 &&
            typeof ending.trial === 'string' &&
            ending.trial.length > 0,
        'Invalid cultivation ending trial mapping',
        ErrorCode.GameConfig,
    )
    const mapping = new Map(),
        trials = tables.get('game_events_cul_trial')
    for (const tuple of ending.trial.split('|')) {
        ensure(/^\d+#\d+$/.test(tuple), 'Malformed cultivation ending trial tuple', ErrorCode.GameConfig)
        const [key, trialId] = tuple.split('#').map(Number)
        ensure(
            uint(key) && uint(trialId) && trialId > 0 && !mapping.has(key),
            'Duplicate or invalid cultivation ending difficulty',
            ErrorCode.GameConfig,
        )
        const matches = trials.filter((trial) => trial.systemId === ending.systemId && trial.trialId === trialId)
        ensure(
            matches.length === 1 &&
                matches[0].phase === 3 &&
                matches[0].ending === ending.endingId &&
                matches[0].difficult === key,
            'Cultivation ending trial reference differs from current configuration',
            ErrorCode.GameConfig,
        )
        mapping.set(key, matches[0])
    }
    return mapping.get(difficulty)
}

export function growupEndingMatchesTrial(tables, ending, trial, difficulty = trial?.difficult) {
    const selected = growupEndingTrial(tables, ending, difficulty)
    return (
        !!selected &&
        trial?.systemId === ending.systemId &&
        trial.ending === ending.endingId &&
        trial.phase === 3 &&
        trial.difficult === difficulty &&
        trial.trialId === selected.trialId
    )
}
