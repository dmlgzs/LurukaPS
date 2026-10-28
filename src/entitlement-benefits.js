import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { battlePassModel, requireBattlePass } from './battle-pass.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'

// These helpers apply real benefits only. The caller owns payment or item provenance.
export function activateMonthlyEntitlement(c, config, count) {
    const previous = c.state.monthlyCard
    ensure(!previous || previous.purchase_sdk_id === config.purchaseSdkID, 'Another monthly-card type is active')
    const end = Math.max(c.now, previous?.end_time ?? 0) + config.day * 86400 * count
    ensure(Number.isSafeInteger(end) && end > c.now, 'Invalid monthly card duration')
    const rewards = grantRewards(
        c.tables,
        c.state,
        parseRewards(config.reward).map((r) => ({ ...r, itemnum: r.itemnum * count })),
    )
    c.state.monthlyCard = {
        ...previous,
        config_id: config.id,
        purchase_sdk_id: config.purchaseSdkID,
        end_time: end,
        claim_until: previous?.claim_until ?? 0,
    }
    return { rewards: { rewards }, first: !previous || previous.end_time <= c.now }
}

export function activateBattlePassEntitlement(c, mode, prepared = requireBattlePass(c), source = 'battlePassPurchase') {
    ensure(
        ['advanced', 'luxury', 'upgrade'].includes(mode),
        'Unknown battle pass entitlement',
        ErrorCode.BattlePassConfInvalid,
    )
    const { season, ledger, key } = prepared,
        model = battlePassModel(c.tables)
    ensure(!ledger.is_refund, 'Battle pass premium is refunded', ErrorCode.BattlePassRefund)
    const cutoff = Number(model.constants.get('BATTLE_PASS_CLOSE_TIME'))
    ensure(
        Number.isSafeInteger(cutoff) && cutoff >= 0,
        'Invalid battle pass purchase cutoff',
        ErrorCode.BattlePassConfInvalid,
    )
    ensure(
        c.now < season.effectiveEnd - cutoff * 60,
        'Battle pass premium purchase is closed',
        ErrorCode.BattlePassNotFond,
    )
    if (mode === 'upgrade')
        ensure(ledger.pay_state > 0, 'Battle pass upgrade requires purchased premium', ErrorCode.BattlePassNotPaid)
    ensure(
        mode === 'upgrade' ? ledger.pay_state === 1 : ledger.pay_state === 0,
        'Battle pass tier is already purchased',
        ErrorCode.BattlePassAlreadyPaid,
    )
    const first = ledger.pay_state === 0,
        pro = mode !== 'advanced'
    const levelBonus = pro ? Number(season.row.luxuryLevelReward) : 0
    ensure(
        Number.isSafeInteger(levelBonus) && levelBonus >= 0,
        'Invalid battle pass luxury level bonus',
        ErrorCode.BattlePassConfInvalid,
    )
    const items = [
        ...(first ? parseRewards(season.row.advancedReward) : []),
        ...(pro ? parseRewards(season.row.luxuryReward) : []),
    ]
    const rewards = grantRewards(c.tables, c.state, items)
    const upLevel = Math.min(levelBonus, season.maxLevel - ledger.level)
    ledger.level += upLevel
    ledger.pay_state = pro ? 2 : 1
    return { season_key: key, data: { rewards: { rewards, src: rewardSource(c.tables, source) }, up_level: upLevel } }
}
