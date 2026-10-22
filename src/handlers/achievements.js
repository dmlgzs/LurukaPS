import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { achievementCatalogue, achievementLedger, observeAchievements, notifyAchievements } from '../achievements.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'
import { claimAchievementPointReward } from '../achievement-point-rewards.js'

export function registerAchievements(on) {
    on('GetAchievementPointReward', claimAchievementPointReward)
    on('AchievementReward', (c, r) => {
        const model = achievementCatalogue(c.tables),
            row = model.byId.get(r.u32)
        ensure(row, 'Unknown achievement', ErrorCode.AchievementConfFail)
        ensure(
            model.rules.get(row.id).supported,
            'Achievement condition source is not implemented',
            ErrorCode.FunctionClosed,
        )
        observeAchievements(c.tables, c.state, c.now)
        const saved = achievementLedger(c.state).entries[row.id]
        ensure(saved?.finishTime > 0, 'Achievement is still running', ErrorCode.AchievementIsRunning)
        if (saved.claimed) return { rewards: [] }
        const rewards = grantRewards(c.tables, c.state, parseRewards(row.reward))
        saved.claimed = true
        notifyAchievements(c, [row.id])
        return { rewards, src: rewardSource(c.tables, 'achievementReward') }
    })
}
