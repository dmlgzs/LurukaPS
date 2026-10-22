import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { MallCatalog } from '../mall.js'
import { spend, spendCurrency } from '../inventory.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { WorldObjectCatalog } from '../world-objects.js'
import { registerPayGoods } from '../mall-pay-goods.js'
export function registerMall(on, tables) {
    const catalog = new MallCatalog(tables),
        drops = new WorldObjectCatalog(tables)
    registerPayGoods(on, catalog)
    on('PlayerMallBuyDiamondGoods', (c, r) => {
        const shop = catalog.shops.get(r.diamond_shop_id),
            goods = catalog.diamond.get(r.diamond_goods_id),
            count = r.buy_count
        ensure(
            shop && goods && String(shop.goodsList).split('|').map(Number).includes(goods.goodsId),
            'Mall goods do not belong to shop',
        )
        ensure(Number.isInteger(count) && count > 0 && count <= 100, 'Invalid purchase count')
        ensure(
            !shop.unlockCondition && !shop.timelimit && !goods.specialPrice,
            'Unsupported mall purchase condition',
            ErrorCode.InvalidProtoID,
        )
        const wire = catalog.goods(false, goods.goodsId, c.state, c.now)
        ensure(
            wire.is_all_cond_done &&
                (!Number(wire.begin_time) || c.now >= Number(wire.begin_time)) &&
                (!Number(wire.end_time) || c.now < Number(wire.end_time)),
            'Mall goods are unavailable',
        )
        ensure(goods.goodsNum <= 0 || wire.curr_purchase_num + count <= goods.goodsNum, 'Mall purchase limit')
        ensure(wire.curr_purchase_num + count <= 0xffffffff, 'Purchase counter overflow')
        for (const cost of parseRewards(goods.costId, true)) {
            const amount = cost.itemnum * count
            if (!amount) continue
            ensure(Number.isSafeInteger(amount) && amount <= 0xffffffff, 'Purchase cost overflow')
            if (cost.itemtype === 3) spend(c.state, new Map([[cost.itemid, amount]]), 0, c.now)
            else {
                ensure(cost.itemtype === 10, 'Unsupported mall currency', ErrorCode.InvalidProtoID)
                if ([901, 902].includes(cost.itemid)) spendStars(c, amount)
                else spendCurrency(c.state, cost.itemid, amount)
            }
        }
        const output = []
        for (const reward of parseRewards(goods.item)) {
            const quantity = reward.itemnum * count
            ensure(Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 0xffffffff, 'Reward quantity overflow')
            if (goods.autoOpen && reward.itemtype === 3) {
                const item = drops.find('common_item', reward.itemid)
                ensure(
                    item?.type === 5 && /^\d+$/.test(String(item.useFunction)),
                    'Unsupported automatic gift',
                    ErrorCode.InvalidProtoID,
                )
                ensure(quantity <= 512, 'Gift roll limit')
                for (let i = 0; i < quantity; i++) output.push(...drops.drops(Number(item.useFunction), c.randomInt))
            } else output.push({ ...reward, itemnum: quantity })
        }
        ensure(output.length, 'Mall reward is empty', ErrorCode.GameConfig)
        const rewards = grantRewards(tables, c.state, output)
        const mall = (c.state.mall ??= {})
        mall.purchases ??= {}
        mall.purchases[`diamond:${goods.goodsId}`] = {
            period: catalog.window(goods, c.now).start,
            count: wire.curr_purchase_num + count,
        }
        syncPlayer({ ...c, push: c.pushBefore })
        return {
            diamond_shop_id: shop.shopId,
            diamond_goods: catalog.goods(false, goods.goodsId, c.state, c.now),
            diamond_rewards: { rewards },
        }
    })
    on('MallExchangeDiamond', (c, r) => {
        const amount = r.u32
        ensure(Number.isInteger(amount) && amount > 0 && amount <= 0xffffffff, 'Invalid diamond exchange amount')
        spendStars(c, amount)
        const rewards = grantRewards(c.tables, c.state, [{ itemtype: 10, itemid: 1, itemnum: amount }])
        // The success callback immediately resumes the purchase; update balances first.
        syncPlayer({ ...c, push: c.pushBefore })
        return { rewards }
    })
    on('PlayerMallGetPayGoodsList', (c, r) => ({
        pay_shop_id: r.pay_shop_id ?? 0,
        pay_goods_id: r.pay_goods_id ?? 0,
        pay_goods_list: catalog.list(true, r.pay_shop_id, r.pay_goods_id, c.state, c.now),
    }))
    on('PlayerMallGetDiamondGoodsList', (c, r) => ({
        diamond_shop_id: r.diamond_shop_id ?? 0,
        diamond_goods_list: catalog.list(false, r.diamond_shop_id, 0, c.state, c.now),
    }))
    on('PlayerMallGetRechargeDiamond', (c) => {
        const records = c.state.mall?.recharges ?? []
        return {
            purchase_sdk_id_list: records.map((r) => r.purchase_sdk_id),
            first_recharge_time_list: records.map((r) => String(r.first_recharge_time)),
        }
    })
    on(
        'GetRechargePopupData',
        (c) => c.state.mall?.popupQueue?.shift() ?? c.state.mall?.pendingPopup ?? { popup_id: 0 },
    )
    on('MallReddotSet', (c, r) => {
        const mall = (c.state.mall ??= {}),
            dots = (mall.reddots ??= { diamond_reddot: [], pay_reddot: [] })
        for (const [field, goods] of [
            ['diamond_reddot', catalog.diamond],
            ['pay_reddot', catalog.pay],
        ]) {
            ensure((r[field] ?? []).length <= goods.size, 'Too many mall red dots')
            const current = new Map(dots[field].map((x) => [x.goods_id, x]))
            for (const item of r[field] ?? []) {
                ensure(
                    goods.has(item.goods_id) &&
                        Number.isInteger(item.status) &&
                        item.status >= 0 &&
                        item.status <= 0xffffffff,
                    'Invalid mall red dot',
                )
                current.set(item.goods_id, { goods_id: item.goods_id, status: item.status })
            }
            dots[field] = [...current.values()]
        }
        c.pushBefore('SCProtoMallReddotSync', dots)
        return {}
    })
}
function spendStars(c, amount) {
    const balance = (id) => BigInt(c.state.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? 0)
    const paid = balance(901),
        bonus = balance(902)
    ensure(paid >= 0n && bonus >= 0n && paid + bonus >= BigInt(amount), 'Insufficient currency')
    // CBT3 displays 901 + 902 as one balance. Bonus-first spending is local policy.
    const bonusCost = Number(bonus < BigInt(amount) ? bonus : BigInt(amount))
    if (bonusCost) spendCurrency(c.state, 902, bonusCost)
    if (amount > bonusCost) spendCurrency(c.state, 901, amount - bonusCost)
}
