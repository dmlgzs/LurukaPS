import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import policy from '../configs/capture-card-stock-policy.json' with { type: 'json' }

const indexes = new WeakMap()
const intMax = 0x7fffffff
function ids(tables) {
    if (!indexes.has(tables)) {
        const set = new Set()
        for (const row of tables.get('common_item')) {
            if (row.type !== 410) continue
            ensure(
                Number.isSafeInteger(row.id) && row.id > 0 && !set.has(row.id),
                'Invalid capture card definition',
                ErrorCode.GameConfig,
            )
            set.add(row.id)
        }
        ensure(set.size > 0, 'Capture card definitions are missing', ErrorCode.GameConfig)
        indexes.set(tables, set)
    }
    return indexes.get(tables)
}
export function captureCardStockRule(tables, tokens) {
    return (
        Array.isArray(tokens) &&
        tokens.length === 3 &&
        tokens[0] === 15022 &&
        tokens[1] === 410 &&
        Number.isSafeInteger(tokens[2]) &&
        tokens[2] > 0 &&
        ids(tables).size > 0
    )
}
export function hasCaptureCardReward(tables, rewards) {
    return rewards.some((row) => row.itemtype === 3 && ids(tables).has(row.itemid) && row.itemnum > 0)
}
export function captureCardStockValue(tables, state, tokens, facts = new Map()) {
    if (!captureCardStockRule(tables, tokens)) return null
    const key = 'held-common-item-type410'
    if (facts.has(key)) return facts.get(key)
    ensure(
        policy.version === 1 &&
            policy.counting === 'client-capture-card-net-stock' &&
            policy.negativeAggregate === 'floor-zero',
        'Invalid capture card stock policy',
        ErrorCode.GameConfig,
    )
    const cards = ids(tables),
        stock = new Map(),
        items = state.player?.sbag_infos?.items
    ensure(Array.isArray(items), 'Capture card inventory is malformed', ErrorCode.GameConfig)
    for (const row of items) {
        ensure(
            row && typeof row === 'object' && !Array.isArray(row),
            'Capture card inventory row is malformed',
            ErrorCode.GameConfig,
        )
        if (!cards.has(row.itemid)) continue
        ensure(
            Number.isSafeInteger(row.itemtype ?? 0) &&
                (row.itemtype ?? 0) >= 0 &&
                (row.itemtype ?? 0) <= 0xffffffff &&
                Number.isSafeInteger(row.itemnum) &&
                row.itemnum >= 0 &&
                row.itemnum <= intMax,
            'Invalid capture card inventory row',
            ErrorCode.GameConfig,
        )
        const total = (stock.get(row.itemid) ?? 0) + row.itemnum
        ensure(
            Number.isSafeInteger(total) && total <= intMax,
            'Capture card quantity exceeds client reader range',
            ErrorCode.GameConfig,
        )
        stock.set(row.itemid, total)
    }
    const debts = new Map()
    if (state.mallDebtPack !== undefined) {
        const rows = state.mallDebtPack?.debt_list
        ensure(Array.isArray(rows), 'Capture card debt pack is malformed', ErrorCode.GameConfig)
        for (const row of rows) {
            ensure(
                row && typeof row === 'object' && !Array.isArray(row),
                'Capture card debt row is malformed',
                ErrorCode.GameConfig,
            )
            const raw = row.item_debt ?? 0,
                id = row.item_id ?? 0
            ensure(
                Number.isSafeInteger(id) &&
                    id >= 0 &&
                    id <= 0xffffffff &&
                    Number.isSafeInteger(row.item_type ?? 0) &&
                    (row.item_type ?? 0) >= 0 &&
                    (row.item_type ?? 0) <= 0xffffffff &&
                    /^\d+$/.test(String(raw)) &&
                    (typeof raw !== 'number' || Number.isSafeInteger(raw)),
                'Invalid capture card debt identity',
                ErrorCode.GameConfig,
            )
            const value = BigInt(raw)
            // DebtItem is signed Int64; do not simulate unsigned wrap as credit.
            ensure(value <= 0x7fffffffffffffffn, 'Capture card debt exceeds client signed range', ErrorCode.GameConfig)
            // The client's dictionary is keyed only by ID. Every row is
            // validated before the last row replaces an earlier ID/type.
            debts.set(id, Number(value > BigInt(intMax) ? BigInt(intMax) : value))
        }
    }
    // GetAllCapturePetBall keeps each ID's signed net value. Only the final
    // achievement aggregate gets a local nonnegative boundary; never floor
    // each card independently and silently erase its outstanding debt.
    let total = 0
    for (const id of cards) total += (stock.get(id) ?? 0) - (debts.get(id) ?? 0)
    ensure(Number.isSafeInteger(total), 'Capture card stock aggregate overflow', ErrorCode.GameConfig)
    const value = Math.max(0, total)
    facts.set(key, value)
    return value
}
