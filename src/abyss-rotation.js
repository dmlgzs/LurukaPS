import activityPolicy from '../configs/activity-policy.json' with { type: 'json' }
import abyssPolicy from '../configs/abyss-policy.json' with { type: 'json' }
import { configTime } from './shops.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
export function activeAbyssRotation(tables, now, policy = abyssPolicy) {
    const rows = tables
            .get('abbys_time')
            .map((row) => ({ ...row, start: configTime(row.startTime), end: configTime(row.endTime) })),
        current = rows.filter((row) => row.start <= now && now < row.end)
    ensure(current.length <= 1, 'Ambiguous abyss rotation configuration', ErrorCode.GameConfig)
    if (current[0]) return { ...current[0], effectiveEnd: current[0].end }
    ensure(
        ['closed', 'activity_policy'].includes(policy.expiredRotation),
        'Invalid abyss rotation compatibility policy',
        ErrorCode.GameConfig,
    )
    if (policy.expiredRotation === 'closed') return null
    const expired = rows.filter((row) => row.end <= now).sort((a, b) => b.start - a.start),
        selected = expired[0],
        end = configTime(activityPolicy.expiredEndTime)
    if (!selected || now >= end) return null
    ensure(!expired[1] || expired[1].start !== selected.start, 'Ambiguous latest abyss rotation', ErrorCode.GameConfig)
    // Local offline activity policy extends only the latest existing key.
    // A future configured season takes precedence as soon as it opens.
    return { ...selected, effectiveEnd: end, extended: true }
}
