import { activeCatalogue, ensureActivePeriods, notifyActive } from '../daily-active.js'
import { ensure } from './common.js'
import { ErrorCode } from '../error-codes.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'

export function registerDailyActive(on) {
    on('GetActiveReward', (c, r) => {
        ensure(
            Array.isArray(r.u32s) &&
                r.u32s.length > 0 &&
                r.u32s.length <= activeCatalogue(c.tables).rows.length &&
                new Set(r.u32s).size === r.u32s.length,
            'Invalid active task reward selection',
            ErrorCode.InvalidArgument,
        )
        const data = activeCatalogue(c.tables),
            ledger = ensureActivePeriods(c.tables, c.state, c.now)
        const selected = r.u32s.map((id) => {
            const row = data.byId.get(id)
            ensure(row, 'Unknown active task', ErrorCode.InvalidArgument)
            const name = row.taskType === 1 ? 'day' : 'week',
                period = ledger[name]
            ensure(
                (period.counts[row.kind] ?? 0) >= row.para,
                'Active task conditions are not complete',
                ErrorCode.kActiveTaskNotComplete,
            )
            return { row, name, claimed: period.claimed.includes(id), rewards: parseRewards(row.activityReward) }
        })
        const rewards = []
        for (const item of selected) {
            if (item.claimed) continue
            rewards.push(...grantRewards(c.tables, c.state, item.rewards))
            const p = c.state.dailyActive[item.name],
                active = p.active + item.row.reward
            ensure(Number.isSafeInteger(active) && active <= 0xffffffff, 'Active value overflow', ErrorCode.GameConfig)
            c.state.dailyActive = {
                ...c.state.dailyActive,
                [item.name]: { ...p, active, claimed: [...p.claimed, item.row.id] },
            }
        }
        notifyActive(c)
        return { rewards, src: rewardSource(c.tables, 'dailyActiveTask') }
    })
}
