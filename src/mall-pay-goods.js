import { ErrorCode } from './error-codes.js'
import { ensure, syncPlayer } from './handlers/common.js'
import { mallConditions } from './mall-conditions.js'
import { parseRewards, grantRewards } from './rewards.js'
import { spendPaidCurrency } from './paid-currency.js'
import { mallScheduleOpen } from './mall-schedule.js'

export function payGoodsPlan(c, r, catalog) {
    const shop = catalog.shops.get(r.pay_shop_id),
        goods = catalog.pay.get(r.pay_goods_id)
    ensure(shop, 'Mall shop does not exist', ErrorCode.MallShopNotExist)
    ensure(
        goods && String(shop.goodsListPurchase).split('|').map(Number).includes(goods.goodsId),
        'Pay goods do not belong to shop',
        ErrorCode.MallGoodsNotExist,
    )
    const count = r.buy_count
    ensure(Number.isSafeInteger(count) && count > 0, 'Invalid mall purchase count', ErrorCode.InvalidArgument)
    ensure(count <= 100, 'Too many mall purchases in one request', ErrorCode.MallBuyCountError)
    const shopCondition = mallConditions(c.tables, c.state, shop.unlockCondition),
        goodsCondition = mallConditions(c.tables, c.state, goods.commonCondition)
    ensure(
        shopCondition.supported && goodsCondition.supported,
        'Mall condition type is not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(shopCondition.passed, 'Mall shop condition is not met', ErrorCode.MallShopCondInvalid)
    ensure(
        mallScheduleOpen(c.tables, shop.timelimit, c.now) && mallScheduleOpen(c.tables, goods.timelimit, c.now),
        'Mall purchase is outside its schedule',
        ErrorCode.MallBuyTimeInvalid,
    )
    ensure(goodsCondition.passed, 'Pay goods ownership condition is not met', ErrorCode.MallGoodsDynamicCondInvalid)
    const wire = catalog.goods(true, goods.goodsId, c.state, c.now)
    ensure(
        Number.isSafeInteger(wire.curr_purchase_num) &&
            wire.curr_purchase_num >= 0 &&
            Number.isSafeInteger(goods.goodsNum) &&
            goods.goodsNum >= 0,
        'Invalid mall quota',
        ErrorCode.MallConfigError,
    )
    ensure(
        !goods.goodsNum || wire.curr_purchase_num + count <= goods.goodsNum,
        'Mall purchase limit reached',
        ErrorCode.MallGoodsNumLimit,
    )
    ensure(wire.curr_purchase_num + count <= 0xffffffff, 'Mall purchase counter overflow', ErrorCode.MallConfigError)
    const output = parseRewards(goods.item).map((reward) => ({ ...reward, itemnum: reward.itemnum * count }))
    ensure(
        output.length > 0 &&
            output.every((x) => Number.isSafeInteger(x.itemnum) && x.itemnum > 0 && x.itemnum <= 0xffffffff),
        'Invalid pay goods rewards',
        ErrorCode.MallConfigError,
    )
    ensure(
        !goods.autoOpen,
        'Automatic pay gift opening requires a separate verified contract',
        ErrorCode.FunctionClosed,
    )
    return { shop, goods, count, wire, output }
}

export function registerPayGoods(on, catalog) {
    on('PlayerMallBuyPayGoods', (c, r) => {
        const plan = payGoodsPlan(c, r, catalog),
            { shop, goods, count, wire, output } = plan
        // Native PageFashionShopBuyTip uses this exact configured diamond cost.
        // A zero-cost cash-only product is not a free diamond purchase.
        ensure(
            Number.isSafeInteger(goods.costPurchaseDiamondNum) && goods.costPurchaseDiamondNum >= 0,
            'Invalid pay goods diamond price',
            ErrorCode.MallConfigError,
        )
        ensure(
            goods.costPurchaseDiamondNum > 0,
            'This cash product cannot be bought with diamonds',
            ErrorCode.MallBuyTypeInvalid,
        )
        const cost = goods.costPurchaseDiamondNum * count
        ensure(
            Number.isSafeInteger(cost) && cost <= 0xffffffff,
            'Pay goods diamond cost overflow',
            ErrorCode.MallConfigError,
        )
        spendPaidCurrency(c.state, cost)
        const rewards = grantRewards(c.tables, c.state, output),
            mall = (c.state.mall ??= {})
        mall.purchases ??= {}
        mall.purchases[`pay:${goods.goodsId}`] = {
            period: catalog.window(goods, c.now).start,
            count: wire.curr_purchase_num + count,
        }
        syncPlayer({ ...c, push: c.pushBefore })
        return {
            pay_shop_id: shop.shopId,
            pay_goods: catalog.goods(true, goods.goodsId, c.state, c.now),
            pay_rewards: { rewards },
        }
    })
}
