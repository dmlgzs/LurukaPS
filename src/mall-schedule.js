import overrides from '../configs/mall-table-overrides.json' with { type: 'json' }
import policy from '../configs/mall-schedule-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { configTime } from './shops.js'

export function mallTableRow(name, original) {
    const row = { ...original }
    for (const [key, patch] of Object.entries(overrides[name]?.[row.goodsId ?? row.shopId] ?? {}))
        if (row[key] === patch.from) row[key] = patch.to
    return row
}

export function mallSchedule(tables, id) {
    if (!id) return { start: 0, end: 0 }
    const row = tables.find('common_timelimit', id)
    if (!row) {
        ensure(
            policy.version === 1 && policy.missingCurrentSchedules?.[id] === 'open-ended-local',
            'Missing mall schedule configuration',
            ErrorCode.MallConfigError,
        )
        return { start: 0, end: 0 }
    }
    return { start: configTime(row.startTime), end: configTime(row.endTime) }
}

export function mallScheduleOpen(tables, id, now) {
    const { start, end } = mallSchedule(tables, id)
    // Native IsGoodsStillOnline includes the configured last second.
    return (!start || now >= start) && (!end || now <= end)
}
