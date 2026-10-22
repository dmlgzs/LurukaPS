import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function exchangeHistorySnapshot(state, consumeNotice = false) {
    const exchange = state.homeExchange
    const info = (exchange?.history ?? [])
        .map((record) => {
            const result = {}
            for (const field of ['history_time', 'profit', 'settle_num', 'extra_num']) {
                const value = record[field] ?? 0
                ensure(
                    Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
                    'Invalid saved exchange history',
                    ErrorCode.GameConfig,
                )
                result[field] = value
            }
            return result
        })
        .sort((a, b) => a.history_time - b.history_time)
    const award = structuredClone(exchange?.pendingNotice ?? { rewards: [] })
    // Awards were already delivered by settlement. This is a UI notice only,
    // never a second invocation of grantRewards when reading the report.
    if (consumeNotice && award.rewards?.length) exchange.pendingNotice = { rewards: [] }
    return { info, extra_info: { award } }
}
