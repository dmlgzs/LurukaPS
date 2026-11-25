import policy from '../configs/mall-schedule-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { configTime } from './shops.js'
import { staticTimeRow } from './time-definitions.js'
import { mallLocalSchedule } from './mall-time-policy.js'

export function mallTableRow(name, original) {
    return { ...original }
}

export function mallSchedule(tables, id, configured = policy) {
    if (!id) return { start: 0, end: 0 }
    const row = staticTimeRow(tables, id)
    if (!row) {
        const local = mallLocalSchedule(tables, id, configured)
        ensure(local, 'Missing mall schedule configuration', ErrorCode.MallConfigError)
        return local
    }
    return { start: configTime(row.startTime), end: configTime(row.endTime) }
}

export function mallScheduleOpen(tables, id, now, configured = policy) {
    const { start, end } = mallSchedule(tables, id, configured)
    // Native IsGoodsStillOnline includes the configured last second.
    return (!start || now >= start) && (!end || now <= end)
}
