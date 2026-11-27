import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

// GrowupSystem.endQuery publishes every complete_end row as GrowUpEnd.state=1.
// Current GlobalData stores that packet by activityId and endingId, then
// GetEndBookNum counts state1 dictionary values. Do not count attempts, claims,
// assistant receipts, or another activity sharing the same ending identifier.
export function completedGrowupEndingCount(state, scenarioId) {
    const records = state.activities?.[scenarioId]?.growup?.end_data?.complete_end
    if (records === undefined) return 0
    ensure(Array.isArray(records), 'Invalid completed cultivation ending book', ErrorCode.GameConfig)
    const endingIds = new Set()
    for (const record of records) {
        ensure(
            record && Number.isSafeInteger(record.id) && record.id > 0 && record.id <= 0xffffffff,
            'Invalid completed cultivation ending identity',
            ErrorCode.GameConfig,
        )
        endingIds.add(record.id)
    }
    return endingIds.size
}
