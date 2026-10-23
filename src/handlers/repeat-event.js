import { repeatEntryPlan, repeatSnapshot } from '../repeat-event.js'
import { startEntrust } from './entrust.js'

export function registerRepeatEvent(on) {
    on('RepeatEventEnterLevelReq', (c, request) => {
        const plan = repeatEntryPlan(c, request)
        const result = startEntrust(c, plan.dungeonId, false, 'repeat')
        c.state.entrust.run.repeat_event = plan
        c.pushBefore('CSProtoRepeatEventSync', repeatSnapshot(c.state))
        return result
    })
}
