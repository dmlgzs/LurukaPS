import { repeatEntryPlan, repeatSnapshot, repeatTaskSnapshot, repeatClaimableTasks } from '../repeat-event.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'
import { claimRepeatFirstPass } from '../repeat-event-rewards.js'
import { startEntrust } from './entrust.js'
import { ensure } from './common.js'
import { ErrorCode } from '../error-codes.js'

export function registerRepeatEvent(on) {
    on('RepeatEventGetTaskReward', (c, request) => {
        const rows = repeatClaimableTasks(c, request.u32s ?? [])
        const rewards = grantRewards(
            c.tables,
            c.state,
            rows.flatMap((row) => parseRewards(row.config.taskReward)),
        )
        for (const row of rows) {
            const ledger = (c.state.repeatEvent = {
                ...c.state.repeatEvent,
                events: { ...c.state.repeatEvent?.events },
            })
            const old = ledger.events[row.event_id]
            ledger.events[row.event_id] = { ...old, claimed_tasks: [...(old?.claimed_tasks ?? []), row.task_id] }
        }
        c.pushBefore('CSProtoRepeatEventTaskModify', repeatTaskSnapshot(c.tables, c.state))
        return { rewards, ...(rewards.length ? { src: rewardSource(c.tables, 'repeatEventTask') } : {}) }
    })
    on('RepeatEventEnterLevelReq', (c, request) => {
        const plan = repeatEntryPlan(c, request)
        const result = startEntrust(c, plan.dungeonId, false, 'repeat')
        c.state.entrust.run.repeat_event = plan
        c.pushBefore('CSProtoRepeatEventSync', repeatSnapshot(c.state, c.activityCatalog, c.now))
        return result
    })
    on('RepeatEventReEnterLevelReq', (c, request) => {
        const plan = repeatEntryPlan(c, request)
        const run = c.state.entrust?.run
        ensure(
            run?.kind === 'repeat' &&
                run.map_id === c.state.world.map_id &&
                ['activity', 'chapter', 'level', 'mode'].every((key) => run.repeat_event?.[key] === plan[key]),
            'The requested repeat challenge is not active',
            ErrorCode.RepeatEventLevelMapInvalid,
        )
        claimRepeatFirstPass(c)
        const result = startEntrust(c, plan.dungeonId, true, 'repeat')
        c.state.entrust.run.repeat_event = plan
        c.pushBefore('CSProtoRepeatEventSync', repeatSnapshot(c.state, c.activityCatalog, c.now))
        return result
    })
}
