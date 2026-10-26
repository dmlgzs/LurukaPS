import { cultRankLedger, cultRankModel, cultRankPeriod, cultRankSnapshot } from './cult-rank-progress.js'

// A pure qualification projection, never a fabricated exact rank or claim receipt.
// For the current >=boundary cutoffs, any real ranked entrant has R<=N and therefore G<=boundary.
export function cultRankOwnValue(tables, state, tokens, activityId, now) {
    const period = cultRankPeriod(activityId, now)
    if (!period) return 0
    const row = cultRankLedger(state.cultRankProgress)?.periods[period.period_key]
    if (!row) return 0
    const model = cultRankModel(tables, activityId),
        value = BigInt(row.best_score),
        threshold = tokens[2]
    if (value >= BigInt(model.boundary.needscore)) return threshold >= model.boundary.predictpercent ? threshold : null
    // The prediction branch does not query any account or require a Store.
    const prediction = cultRankSnapshot(null, tables, state, 0, activityId, now)
    return prediction && prediction.qualification > 0 && prediction.qualification <= threshold ? threshold : 0
}
