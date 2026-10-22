import { ErrorCode } from './error-codes.js'
import { ensure, syncPlayer } from './handlers/common.js'
import { battlePassModel, requireBattlePass } from './battle-pass.js'
import { parseRewards } from './rewards.js'
import { spend, spendCurrency } from './inventory.js'
export function battlePassLevelInfo(season, ledger) {
    return {
        battlepass_id: season.row.id,
        level: ledger.level,
        exp: ledger.exp,
        curr_week_exp: ledger.curr_week_exp,
        pay_state: ledger.pay_state,
    }
}
export function buyBattlePassLevels(c, r) {
    const { season, ledger } = requireBattlePass(c),
        count = r.u32
    ensure(Number.isSafeInteger(count) && count > 0, 'Invalid battle pass level count')
    const previous = c.requestKey && ledger.levelPurchases?.[c.requestKey]
    if (previous !== undefined) {
        ensure(previous === count, 'Battle pass purchase sequence changed')
        return battlePassLevelInfo(season, ledger)
    }
    ensure(
        count <= season.maxLevel - ledger.level,
        'Battle pass maximum level exceeded',
        ErrorCode.BattlePassLevelExceeded,
    )
    const model = battlePassModel(c.tables),
        cutoff = Number(model.constants.get('BATTLE_PASS_CLOSE_TIME'))
    ensure(
        Number.isSafeInteger(cutoff) && cutoff >= 0,
        'Invalid battle pass closing interval',
        ErrorCode.BattlePassConfInvalid,
    )
    ensure(
        c.now <= season.effectiveEnd - cutoff * 60,
        'Battle pass level purchase is closed',
        ErrorCode.BattlePassNotFond,
    )
    const costs = parseRewards(model.constants.get('BATTLE_PASS_BUY_LEVEL'))
    ensure(costs.length > 0, 'Battle pass purchase cost unavailable', ErrorCode.BattlePassConfInvalid)
    for (const cost of costs) {
        const amount = cost.itemnum * count
        ensure(
            Number.isSafeInteger(amount) && amount > 0 && amount <= 0xffffffff,
            'Battle pass purchase cost overflow',
            ErrorCode.BattlePassConfInvalid,
        )
        if (cost.itemtype === 3) spend(c.state, new Map([[cost.itemid, amount]]), 0, c.now)
        else {
            ensure(cost.itemtype === 10, 'Battle pass purchase cost type not implemented', ErrorCode.FunctionClosed)
            spendCurrency(c.state, cost.itemid, amount)
        }
    }
    ledger.level += count
    if (c.requestKey) {
        ledger.levelPurchases ??= {}
        ledger.levelPurchases[c.requestKey] = count
    }
    // Paid level purchases do not count toward weekly earned task experience.
    // Preserve existing remainder; current UI hides progress at maximum level.
    syncPlayer({ ...c, push: c.pushBefore })
    return battlePassLevelInfo(season, ledger)
}
