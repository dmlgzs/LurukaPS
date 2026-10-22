import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards, parseRewards } from './rewards.js'
import { journeyLedger, journeyModel, journeyPoints, publishJourney, observeJourney } from './journey.js'
import { rewardSource } from './reward-source.js'

const catalogues = new WeakMap()
export function journeyPointRows(tables, state) {
    let rows = catalogues.get(tables)
    if (!rows) {
        rows = tables.get('journey_point_reward')
        ensure(
            rows.length > 0 &&
                rows.length <= 32 &&
                new Set(rows.map((r) => r.id)).size === rows.length &&
                rows.every(
                    (r, index) =>
                        Number.isInteger(r.id) &&
                        r.id > 0 &&
                        Number.isInteger(r.point) &&
                        r.point > 0 &&
                        (!index || rows[index - 1].point < r.point) &&
                        [0, 1].includes(r.isBigReward),
                ),
            'Invalid journey point reward configuration',
            ErrorCode.JourneyConfError,
        )
        rows = rows.map((row, index) => ({ ...row, bit: 2 ** index, rewards: parseRewards(row.reward) }))
        catalogues.set(tables, rows)
    }
    const mask = journeyLedger(state).pointMask
    ensure(
        BigInt(mask) < 1n << BigInt(rows.length),
        'Journey reward mask has unknown bits',
        ErrorCode.JourneyTypeDateError,
    )
    return rows
}
export function hasJourneyPointClaim(ledger, row) {
    return (BigInt(ledger.pointMask) & BigInt(row.bit)) !== 0n
}
export function markJourneyPointClaim(ledger, row) {
    ledger.pointMask = Number(BigInt(ledger.pointMask) | BigInt(row.bit))
}
export function claimJourneyPointRewards(c) {
    observeJourney(c.tables, c.state)
    const model = journeyModel(c.tables),
        ledger = journeyLedger(c.state),
        points = journeyPoints(model, c.state)
    const rows = journeyPointRows(c.tables, c.state),
        eligible = rows.filter((r) => !r.isBigReward && r.point <= points)
    ensure(eligible.length > 0, 'No journey point reward is available', ErrorCode.JourneyNoReward)
    const fresh = eligible.filter((r) => !hasJourneyPointClaim(ledger, r))
    const rewards = grantRewards(
        c.tables,
        c.state,
        fresh.flatMap((r) => r.rewards),
    )
    for (const row of fresh) markJourneyPointClaim(ledger, row)
    publishJourney(c)
    // No source ID is present in the actual journey rows. This deliberately
    // logs a missing mapping and preserves earned rewards, never guesses ID88.
    return { rewards, ...(rewards.length ? { src: rewardSource(c.tables, 'journeyPointReward') } : {}) }
}
