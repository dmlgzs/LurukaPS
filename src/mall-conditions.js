import { cosmeticOwnedCount } from './appearance-rewards.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const catalogs = new WeakMap()
function soldOut(tables, state, type, goodsId) {
    let catalog = catalogs.get(tables)
    if (!catalog) {
        catalog = {
            diamond: new Map(tables.get('mall_goods').map((row) => [row.goodsId, row])),
            pay: new Map(tables.get('mall_pay_goods').map((row) => [row.goodsId, row])),
            shops: tables.get('mall_shop'),
        }
        catalogs.set(tables, catalog)
    }
    const isPay = type === 2,
        row = (isPay ? catalog.pay : catalog.diamond).get(goodsId)
    ensure(
        row && (isPay || !catalog.pay.has(goodsId)),
        'Mall prerequisite goods category or reference is invalid',
        ErrorCode.MallConfigError,
    )
    const memberships = catalog.shops.filter((shop) =>
        String(isPay ? shop.goodsListPurchase : shop.goodsList)
            .split('|')
            .map(Number)
            .includes(goodsId),
    )
    ensure(
        memberships.length === 1,
        'Mall prerequisite shop reference is unavailable or ambiguous',
        ErrorCode.MallConfigError,
    )
    ensure(
        Number.isSafeInteger(row.goodsNum) && row.goodsNum >= -0x80000000 && row.goodsNum <= 0x7fffffff,
        'Invalid prerequisite mall stock limit',
        ErrorCode.MallConfigError,
    )
    // ShopStore.GetGoodsHaveAnyStockNum treats every fullStock<=0 as unlimited.
    if (row.goodsNum <= 0) return { known: true, passed: false }
    // All current12280 references are lifetime or BeginTime. BeginTime is
    // explicitly held until an authoritative period by the existing local
    // policy. A future cyclic prerequisite needs a clock/window contract;
    // never borrow its old-period count from a clock-free predicate.
    if (![1, 6].includes(row.refreshType)) return { known: false, passed: false }
    const record = state.mall?.purchases?.[`${isPay ? 'pay' : 'diamond'}:${goodsId}`]
    ensure(
        record === undefined ||
            (record &&
                typeof record === 'object' &&
                !Array.isArray(record) &&
                Number.isSafeInteger(record.count) &&
                record.count >= 0 &&
                record.count <= 0xffffffff),
        'Invalid prerequisite mall purchase history',
        ErrorCode.MallConfigError,
    )
    return { known: true, passed: (record?.count ?? 0) >= row.goodsNum }
}

export function mallConditions(tables, state, text) {
    const ids = [],
        progress = [],
        processChecks = [],
        staticChecks = [],
        checks = []
    let supported = true
    for (const token of String(text ?? '')
        .split('|')
        .filter(Boolean)) {
        const parts = token.split('#').map(Number),
            [kind, a, b, count] = parts
        ensure(
            parts.every((n) => Number.isSafeInteger(n) && n >= 0) && kind > 0,
            'Invalid mall condition',
            ErrorCode.MallConfigError,
        )
        // These two current conditions are checked locally by the Native
        // static-condition path. Their rows have no matching unlockParam slot;
        // advertising them as process IDs can index beyond that table array.
        const process = kind !== 12280 && kind !== 12083
        let value = 0,
            known = true,
            passed = false
        if (kind === 2004 && parts.length === 2 && a > 0) {
            value = Math.min(state.player.basic_info.lv, a)
            passed = value >= a
        } else if (kind === 2007 && parts.length === 2 && a > 0) {
            value = (state.taskRecords ?? []).some((r) => r.task_id === a && r.count > 0) ? a : 0
            passed = value >= a
        } else if (kind === 12081 && parts.length === 4 && a > 0 && b > 0) {
            // HaveItemCond.OnCheckCond uses exact equality, including zero.
            const owned = cosmeticOwnedCount(tables, state, a, b)
            known = owned !== null
            value = owned ?? 0
            passed = known && value === count
        } else if (kind === 12083 && parts.length === 5 && a > 0 && b > 0) {
            const owned = cosmeticOwnedCount(tables, state, a, b)
            known = owned !== null
            value = owned ?? 0
            passed = known && value >= count && value <= parts[4]
        } else if (kind === 12280 && parts.length === 3 && [1, 2].includes(a) && b > 0) {
            const result = soldOut(tables, state, a, b)
            known = result.known
            passed = result.passed
            value = passed ? 1 : 0
        } else known = false
        supported &&= known
        if (process) {
            ids.push(kind)
            progress.push(value)
            processChecks.push(passed)
        } else staticChecks.push(passed)
        checks.push(passed)
    }
    return {
        ids,
        progress,
        passed: checks.every(Boolean),
        processPassed: processChecks.every(Boolean),
        staticPassed: staticChecks.every(Boolean),
        supported,
    }
}
