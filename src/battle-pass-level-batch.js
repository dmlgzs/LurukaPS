import { requireBattlePass, publishBattlePassRewards } from './battle-pass.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
export function claimAllBattlePassLevels(c) {
    const { season, ledger } = requireBattlePass(c),
        selected = []
    for (const row of season.rewards) {
        if (row.level > ledger.level) break
        if (!ledger.free.includes(row.level)) selected.push({ row, paid: false })
        if (ledger.pay_state > 0 && !ledger.is_refund && !row.soulessenceMark && !ledger.paid.includes(row.level))
            selected.push({ row, paid: true })
    }
    const rewards = grantRewards(
        c.tables,
        c.state,
        selected.flatMap(({ row, paid }) => parseRewards(paid ? row.advancedReward : row.commonReward)),
    )
    for (const { row, paid } of selected) (paid ? ledger.paid : ledger.free).push(row.level)
    ledger.free.sort((a, b) => a - b)
    ledger.paid.sort((a, b) => a - b)
    publishBattlePassRewards(c, ledger)
    // Tables label separate free and paid sources. No confirmed mixed-batch
    // source exists; log missing metadata and preserve delivery rather than guess.
    return { rewards, ...(rewards.length ? { src: rewardSource(c.tables, 'battlePassAllLevels') } : {}) }
}
