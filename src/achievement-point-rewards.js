import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { achievementLedger, achievementPoints, observeAchievements, achievementSnapshot } from './achievements.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'

const catalogues = new WeakMap()
export function achievementPointCatalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const rows = [...tables.get('achievement_award')].sort((a, b) => a.achiPoint - b.achiPoint)
    const byId = new Map()
    let threshold = 0
    for (const row of rows) {
        ensure(
            Number.isSafeInteger(row.id) &&
                row.id > 0 &&
                !byId.has(row.id) &&
                Number.isSafeInteger(row.achiPoint) &&
                row.achiPoint > threshold &&
                typeof row.reward === 'string',
            'Malformed achievement point reward configuration',
            ErrorCode.GameConfig,
        )
        byId.set(row.id, row)
        threshold = row.achiPoint
    }
    ensure(rows.length > 0, 'Missing achievement point rewards', ErrorCode.GameConfig)
    const value = { rows, byId, thresholds: new Set(rows.map((row) => row.achiPoint)) }
    catalogues.set(tables, value)
    return value
}

export function claimAchievementPointReward(c, request) {
    const model = achievementPointCatalogue(c.tables),
        row = model.byId.get(request.u32)
    ensure(row, 'Unknown achievement point reward', ErrorCode.AchievementConfFail)
    observeAchievements(c.tables, c.state, c.now)
    const ledger = achievementLedger(c.state),
        last = ledger.lastAwardPoint
    ensure(
        last === 0 || model.thresholds.has(last),
        'Saved achievement award threshold is invalid',
        ErrorCode.GameConfig,
    )
    if (row.achiPoint <= last) return { rewards: [] }
    const next = model.rows.find((candidate) => candidate.achiPoint > last)
    ensure(row.id === next?.id, 'Claim preceding achievement point rewards first', ErrorCode.AchievementCantReward)
    ensure(
        achievementPoints(c.tables, c.state) >= row.achiPoint,
        'Insufficient completed achievement points',
        ErrorCode.AchievementCantReward,
    )
    const rewards = grantRewards(c.tables, c.state, parseRewards(row.reward))
    ledger.lastAwardPoint = row.achiPoint
    c.pushBefore('CSProtoAchievementSync', achievementSnapshot(c.tables, c.state, c.now))
    return { rewards, src: rewardSource(c.tables, 'achievementPointReward') }
}
