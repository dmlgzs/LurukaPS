import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
import { journeyModel, journeyLedger, journeyPoints, observeJourney, publishJourney } from './journey.js'
import { journeyPointRows, hasJourneyPointClaim, markJourneyPointClaim } from './journey-point-rewards.js'

export function claimJourneySpecialReward(c, r) {
    const selected = r.u32s
    ensure(
        Array.isArray(selected) &&
            selected.length === 2 &&
            selected.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff),
        'Invalid journey special reward selection',
        ErrorCode.InvalidArgument,
    )
    const [itemid, itemtype] = selected
    observeJourney(c.tables, c.state)
    const model = journeyModel(c.tables),
        ledger = journeyLedger(c.state),
        points = journeyPoints(model, c.state)
    const bigRows = journeyPointRows(c.tables, c.state).filter((row) => row.isBigReward)
    // The current client has one final choice box and no requested row ID.
    // Do not silently invent an ordering rule for multiple future big boxes.
    ensure(bigRows.length === 1, 'Ambiguous journey special reward configuration', ErrorCode.JourneyConfError)
    const row = bigRows[0]
    ensure(
        row.rewards.length === 1 && row.rewards[0].itemtype === 3 && row.rewards[0].itemnum === 1,
        'Journey special reward is not a configured selection box',
        ErrorCode.JourneyConfError,
    )
    const box = c.tables.find('common_item', row.rewards[0].itemid)
    ensure(
        box?.useType === 3 && box.giftBagReward,
        'Journey selection box configuration is unavailable',
        ErrorCode.JourneyConfError,
    )
    const options = parseRewards(box.giftBagReward)
    const chosen = options.find((option) => option.itemid === itemid && option.itemtype === itemtype)
    ensure(
        chosen && chosen.itemtype === 9 && chosen.itemnum === 1 && c.tables.find('soulessence', chosen.itemid),
        'Reward is not in the configured journey selection box',
        ErrorCode.InvalidArgument,
    )
    ensure(points >= row.point, 'Journey special reward point condition is unmet', ErrorCode.JourneyContReward)
    if (hasJourneyPointClaim(ledger, row)) {
        ensure(
            ledger.specialItem?.itemid === itemid && ledger.specialItem?.itemtype === itemtype,
            'Journey special reward was already chosen',
            ErrorCode.JourneyNoReward,
        )
        return { rewards: [] }
    }
    const rewards = grantRewards(c.tables, c.state, [chosen])
    ensure(
        rewards.length === 1 && rewards[0].guid,
        'Journey soul essence instance was not created',
        ErrorCode.GameConfig,
    )
    ledger.specialItem = { ...rewards[0] }
    markJourneyPointClaim(ledger, row)
    publishJourney(c)
    return { rewards, src: rewardSource(c.tables, 'journeySpecialReward') }
}
