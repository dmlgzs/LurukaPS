import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'

export function ordinaryGoodsPricing(goods) {
    const special = goods.specialPrice
    ensure(
        Number.isSafeInteger(special) && special >= 0 && special <= 10000,
        'Invalid ordinary shop special-price metadata',
        ErrorCode.GameConfig,
    )
    ensure(typeof goods.recommend === 'string', 'Invalid ordinary shop recommendation metadata', ErrorCode.GameConfig)
    ensure(
        goods.recommend === '',
        'Ordinary shop alternate recommendation pricing is not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(typeof goods.costId === 'string', 'Missing ordinary shop cost definition', ErrorCode.GameConfig)
    const costs = parseRewards(goods.costId, true)
    ensure(
        costs.every((cost) => [3, 10].includes(cost.itemtype)),
        'Ordinary shop payment kind is not implemented',
        ErrorCode.FunctionClosed,
    )
    const current = costs[0]?.itemnum ?? 0
    let originalUnitPrice = null
    if (special > 0 && current > 0) {
        ensure(special < 10000, 'Positive shop price has a zero original-price divisor', ErrorCode.GameConfig)
        // Current GetNoneMallLinePriceByGoodsId0601ca03 computes display-only
        // Ceiling(costId[0][2]*10000/(10000-specialPrice)) BEFORE quantity.
        const divisor = BigInt(10000 - special)
        originalUnitPrice = Number((BigInt(current) * 10000n + divisor - 1n) / divisor)
    }
    // costId already is the actual payable price. Never apply this strike-price
    // metadata a second time or use specialTips/reward previews as a tariff.
    return { costs, specialPrice: special, originalUnitPrice }
}
