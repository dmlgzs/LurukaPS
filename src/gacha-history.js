import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

function uint64(value, code, message) {
    const text = String(value)
    ensure(/^\d+$/.test(text) && BigInt(text) <= 0xffffffffffffffffn, message, code)
    return BigInt(text)
}
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff

export function gachaHistoryPage(catalog, state, request) {
    ensure(catalog.types.has(request.gacha_type), 'Unknown gacha history category')
    const limit = request.select_num ?? 20
    ensure(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Invalid gacha history page size')
    const cursor = uint64(request.cursor ?? '0', ErrorCode.InvalidArgument, 'Invalid gacha history cursor')
    const history = state.gacha?.history ?? []
    ensure(Array.isArray(history), 'Invalid saved gacha history', ErrorCode.GameConfig)
    const seen = new Set(),
        matching = []
    for (const row of history) {
        ensure(row && typeof row === 'object', 'Invalid saved gacha history row', ErrorCode.GameConfig)
        const id = uint64(row.record_id, ErrorCode.GameConfig, 'Invalid gacha history identity')
        ensure(id > 0n && !seen.has(String(id)), 'Duplicate gacha history identity', ErrorCode.GameConfig)
        seen.add(String(id))
        ensure(uint(row.pool_id) && row.pool_id > 0, 'Invalid saved gacha history pool', ErrorCode.GameConfig)
        const type = row.gacha_type ?? catalog.configuration(row.pool_id).gachaType
        ensure(catalog.types.has(type), 'Invalid saved gacha history category', ErrorCode.GameConfig)
        const time = uint64(row.gacha_time, ErrorCode.GameConfig, 'Invalid gacha history time')
        ensure(
            Array.isArray(row.item) &&
                row.item.length > 0 &&
                row.item.every(
                    (item) =>
                        item && ['item_type', 'item_id', 'item_num'].every((key) => uint(item[key]) && item[key] > 0),
                ),
            'Invalid saved gacha history rewards',
            ErrorCode.GameConfig,
        )
        if (type === request.gacha_type)
            matching.push({
                id,
                item: {
                    record_id: String(id),
                    pool_id: row.pool_id,
                    gacha_time: String(time),
                    item: row.item.map((item) => ({
                        item_type: item.item_type,
                        item_id: item.item_id,
                        item_num: item.item_num,
                    })),
                },
            })
    }
    matching.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))
    const remaining = matching.filter((row) => cursor === 0n || row.id < cursor)
    const selected = remaining.slice(0, limit),
        has_more = remaining.length > selected.length
    return {
        items: selected.map((row) => row.item),
        total_count: String(matching.length),
        next_cursor: has_more ? String(selected.at(-1).id) : '0',
        has_more,
    }
}
