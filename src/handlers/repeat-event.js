import { repeatEntryPlan, repeatSnapshot } from '../repeat-event.js'
import { startEntrust } from './entrust.js'
import { ensure } from './common.js'
import { ErrorCode } from '../error-codes.js'

export function registerRepeatEvent(on) {
    on('RepeatEventEnterLevelReq', (c, request) => {
        const plan = repeatEntryPlan(c, request)
        const result = startEntrust(c, plan.dungeonId, false, 'repeat')
        c.state.entrust.run.repeat_event = plan
        c.pushBefore('CSProtoRepeatEventSync', repeatSnapshot(c.state))
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
        const result = startEntrust(c, plan.dungeonId, true, 'repeat')
        c.state.entrust.run.repeat_event = plan
        c.pushBefore('CSProtoRepeatEventSync', repeatSnapshot(c.state))
        return result
    })
}
