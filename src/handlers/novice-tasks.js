import { NoviceTasks } from '../novice-tasks.js'
import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'

export function registerNoviceTasks(on, tables) {
    const system = new NoviceTasks(tables)
    on('NoviceTaskFinish', (c, r) => {
        const row = system.tasks.get(r.u32)
        ensure(row, 'Unknown novice task', ErrorCode.NoviceTaskNotExists)
        ensure(
            system.unlocked(c.state, system.groups.get(row.groupId)),
            'Novice group locked',
            ErrorCode.NoviceTaskLock,
        )
        system.observe(c.state)
        const ledger = system.ledger(c.state)
        if (ledger.claimedTasks[row.id]) return { rewards: [] }
        ensure(system.value(c.state, row) !== null, 'Novice condition not implemented', ErrorCode.FunctionClosed)
        ensure(ledger.completedTasks[row.id], 'Novice task not complete', ErrorCode.NoviceTaskNotFinished)
        const rewards = grantRewards(tables, c.state, parseRewards(row.reward))
        ledger.claimedTasks[row.id] = true
        system.notify(c)
        return { rewards, src: rewardSource(tables, 'noviceTaskReward') }
    })
    return system
}
