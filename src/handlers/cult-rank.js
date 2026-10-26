import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { cultRankSnapshot, cultRankModel } from '../cult-rank-progress.js'

export function registerCultRank(on, tables, store, catalog) {
    on('GetRankDetail', (c, r) => {
        const key = r.rank_key
        ensure(
            key && Number.isInteger(key.typ) && key.typ > 0,
            'Invalid cultivation rank key',
            ErrorCode.ActivityGrowUpInvalidParam,
        )
        ensure(key.typ === 1, 'This ranking mode is not implemented', ErrorCode.FunctionClosed)
        ensure(
            Number.isInteger(key.activity_id) &&
                key.activity_id > 0 &&
                key.activity_id <= 0xffffffff &&
                (key.conf_id ?? 0) === 0,
            'Invalid cultivation rank selector',
            ErrorCode.ActivityGrowUpInvalidParam,
        )
        const { activity } = cultRankModel(tables, key.activity_id)
        ensure(
            catalog.active(activity, c.state, c.now),
            'Cultivation ranking activity is closed',
            ErrorCode.ActivityNotOpen,
        )
        const value = cultRankSnapshot(store, tables, c.state, c.id, activity.id, c.now)
        ensure(value?.ranked, 'No trusted ranked cultivation participation', ErrorCode.ActivityDataNone)
        // The client scales this ranked-subset P by the table's 20% boundary.
        // Success zero is forbidden: it would display a false 1% on CBT3.
        c.pushBefore('CSProtoGetRankDetailNtf', {
            rank_key: { typ: 1, activity_id: activity.id, conf_id: 0 },
            rank: String(value.rank),
            rank_size: String(value.count),
            permyriad: String(value.permyriad),
        })
        return {}
    })
}
