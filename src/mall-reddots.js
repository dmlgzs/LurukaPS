import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// The client does not submit cycle_time. Its status-2 reset branch compares
// this server-owned deadline with NowServer; use the same quota calendar as
// PlayerMallGoods.reset_time, independently of the goods' sale time window.
export function mallReddotUpdate(catalog, previous, request, now) {
    const result = {}
    for (const [field, goods] of [
        ['diamond_reddot', catalog.diamond],
        ['pay_reddot', catalog.pay],
    ]) {
        const incoming = request[field] ?? [],
            saved = previous?.[field] ?? []
        ensure(Array.isArray(incoming) && incoming.length <= goods.size, 'Too many mall red dots')
        ensure(Array.isArray(saved), 'Invalid saved mall red dots', ErrorCode.MallConfigError)
        const current = new Map(saved.map((entry) => [entry.goods_id, entry]))
        for (const item of incoming) {
            const row = goods.get(item?.goods_id)
            ensure(
                row && Number.isInteger(item.status) && item.status >= 0 && item.status <= 0xffffffff,
                'Invalid mall red dot',
            )
            let cycle = 0
            if (item.status === 2 && [2, 3].includes(row.redDots) && [3, 4, 5].includes(row.refreshType)) {
                const period = catalog.window(row, now)
                ensure(
                    Number.isSafeInteger(period.end) && period.end > now,
                    'Invalid mall red dot reset period',
                    ErrorCode.MallConfigError,
                )
                cycle = period.end
            }
            current.set(item.goods_id, { goods_id: item.goods_id, status: item.status, cycle_time: String(cycle) })
        }
        // A query must not replace an old unknown dismissal date with today's
        // deadline. Old status-2 records without cycle_time remain unchanged;
        // only a new explicit client status update establishes its period.
        result[field] = [...current.values()]
    }
    return result
}
