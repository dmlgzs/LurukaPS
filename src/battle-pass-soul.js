import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { requireBattlePass, publishBattlePassRewards } from './battle-pass.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
export function claimBattlePassSoul(c, r) {
    const selected = r.u32s
    ensure(
        Array.isArray(selected) && selected.length === 3 && selected.every((n) => Number.isSafeInteger(n) && n > 0),
        'Invalid battle pass soul selection',
    )
    const [level, itemtype, itemid] = selected,
        { season, ledger } = requireBattlePass(c)
    ensure(!ledger.is_refund, 'Battle pass premium is refunded', ErrorCode.BattlePassRefund)
    ensure(ledger.pay_state > 0, 'Battle pass premium is not purchased', ErrorCode.BattlePassNotPaid)
    const rows = season.rewards.filter((row) => row.soulessenceMark === 1)
    ensure(rows.length === 1, 'Ambiguous battle pass soul tier', ErrorCode.BattlePassConfInvalid)
    const row = rows[0]
    ensure(
        level === row.level && level <= ledger.level,
        'Battle pass soul level is not reached',
        ErrorCode.BattlePassLevelExceeded,
    )
    const rewards = parseRewards(row.advancedReward)
    ensure(
        rewards.length === 1 && rewards[0].itemtype === 3 && rewards[0].itemnum === 1,
        'Battle pass soul box configuration invalid',
        ErrorCode.BattlePassConfInvalid,
    )
    const box = c.tables.find('common_item', rewards[0].itemid)
    ensure(box?.useType === 3 && box.giftBagReward, 'Battle pass soul box unavailable', ErrorCode.BattlePassConfInvalid)
    const option = parseRewards(box.giftBagReward).find((x) => x.itemtype === itemtype && x.itemid === itemid)
    const resource = c.tables
        .get('battle_pass_resource')
        .find((x) => x.groupId === season.row.resourceId && x.soulessenceId === itemid)
    ensure(
        itemtype === 9 && option?.itemnum === 1 && resource && c.tables.find('soulessence', itemid),
        'Soul essence is not a battle pass option',
    )
    if (ledger.paid.includes(level)) {
        ensure(
            ledger.soulChoice?.itemid === itemid && ledger.soulChoice?.itemtype === itemtype,
            'Battle pass soul was already selected',
            ErrorCode.BattlePassLevelAlreadyReceived,
        )
        publishBattlePassRewards(c, ledger)
        return { rewards: [] }
    }
    const granted = grantRewards(c.tables, c.state, [option])
    ensure(granted.length === 1 && granted[0].guid, 'Battle pass soul instance missing', ErrorCode.GameConfig)
    ledger.soulChoice = { ...granted[0], level }
    ledger.paid.push(level)
    ledger.paid.sort((a, b) => a - b)
    publishBattlePassRewards(c, ledger)
    return { rewards: granted, src: rewardSource(c.tables, 'battlePassSoul') }
}
