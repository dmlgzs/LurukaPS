import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { requireBattlePass } from './battle-pass.js'
import {
    battlePassTaskModel,
    battlePassTaskSnapshot,
    grantBattlePassTaskExp,
    publishBattlePassTasks,
} from './battle-pass-tasks.js'
import { rewardSource } from './reward-source.js'
export function claimAllBattlePassTasks(c) {
    const p = requireBattlePass(c),
        data = battlePassTaskSnapshot(c.tables, c.state, c.now, p),
        ready = new Set(
            [...data.day_task, ...data.week_task, ...data.forever_task]
                .filter((x) => x.state === 1)
                .map((x) => x.task_id),
        )
    const eligible = battlePassTaskModel(c.tables).rows.filter((row) => row.supported && ready.has(row.id))
    ensure(
        p.ledger.level < p.season.maxLevel || eligible.length === 0,
        'Battle pass maximum level reached',
        ErrorCode.BattlePassLevelExceeded,
    )
    let amount = 0
    // Current source order is daily, weekly, fixed. This deterministic local
    // batch order only matters at the weekly cap; never guess missing tasks.
    for (const row of eligible) {
        if (p.ledger.level >= p.season.maxLevel) break
        const granted = grantBattlePassTaskExp(c, p, row)
        amount += granted.reduce((n, r) => n + r.itemnum, 0)
        ensure(
            Number.isSafeInteger(amount) && amount <= 0xffffffff,
            'Battle pass task XP total overflow',
            ErrorCode.BattlePassConfInvalid,
        )
    }
    publishBattlePassTasks(c, p)
    return {
        rewards: amount ? [{ itemtype: 10, itemid: 50, itemnum: amount }] : [],
        ...(amount ? { src: rewardSource(c.tables, 'battlePassTask') } : {}),
    }
}
