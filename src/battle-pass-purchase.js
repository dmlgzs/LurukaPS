import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { battlePassModel, requireBattlePass } from './battle-pass.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
const modes = [
    ['BATTLEPASS_PURCHASE_SDK_ID_ADV', 'advanced'],
    ['BATTLEPASS_PURCHASE_SDK_ID_LUXURY', 'luxury'],
    ['BATTLEPASS_PURCHASE_SDK_ID_UP', 'upgrade'],
]
const sdkModes = new WeakMap()
export function battlePassPurchaseMode(tables, id) {
    if (!sdkModes.has(tables)) {
        const values = new Map(tables.get('mall_game').map((row) => [row.title, row.value]))
        sdkModes.set(tables, new Map(modes.map(([name, mode]) => [Number(values.get(name)), mode])))
    }
    // Unrelated monthly/recharge products do not load or depend on battle-pass
    // season configuration; compile the full catalogue only for a real match.
    return sdkModes.get(tables).get(id) ?? null
}
export function purchaseBattlePass(c, sdk, count, orderId) {
    const mode = battlePassPurchaseMode(c.tables, sdk.id)
    ensure(mode, 'Battle pass purchase product is not configured', ErrorCode.BattlePassConfInvalid)
    ensure(count === 1, 'Battle pass entitlement purchase count must be one')
    const { season, ledger, key } = requireBattlePass(c),
        model = battlePassModel(c.tables),
        ids = modes.map(([name]) => Number(model.constants.get(name)))
    ensure(
        ids.every((n) => Number.isSafeInteger(n) && n > 0) &&
            new Set(ids).size === ids.length &&
            typeof sdk.itemId === 'string' &&
            sdk.itemId.length > 0,
        'Invalid battle pass SDK configuration',
        ErrorCode.BattlePassConfInvalid,
    )
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
    ledger.premiumOrders ??= []
    ledger.premiumOrders.push({
        order_id: orderId,
        purchase_sdk_id: sdk.id,
        sdk_item_id: sdk.itemId,
        time: c.now,
        mode,
    })
    return {
        season_key: key,
        sdk_item_id: sdk.itemId,
        data: { rewards: { rewards, src: rewardSource(c.tables, 'battlePassPurchase') }, up_level: upLevel },
    }
}
