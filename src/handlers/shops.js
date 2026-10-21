import { ErrorCode } from '../error-codes.js'
import { ShopCatalog } from '../shops.js'
import { ensure, syncPlayer } from './common.js'
import { spend, spendCurrency } from '../inventory.js'
import { grantRewards, parseRewards } from '../rewards.js'
export function registerShops(on, tables) {
    const catalog = new ShopCatalog(tables)
    on('ShopInfoReq', (c, r) => {
        c.push('SCProtoShopInfoSync', { shop_id: r.shop_id, shop_info: catalog.info(r.shop_id, c.state, c.now) })
        return {}
    })
    on('ListShopArrayItems', (c, r) => {
        ensure(r.shop_ids.length > 0 && r.shop_ids.length <= 50, 'Invalid shop query')
        return { infos: [...new Set(r.shop_ids)].map((id) => catalog.info(id, c.state, c.now)) }
    })
    on('ShopBuyItems', (c, r) => {
        const shop = catalog.shop(r.shop_id, c.state, c.now)
        ensure(shop.open, 'Shop is not open', ErrorCode.ShopNotOpen)
        ensure(r.items.length > 0 && r.items.length <= 100, 'Invalid shop basket')
        const basket = new Map()
        for (const line of r.items) {
            ensure(Number.isInteger(line.times) && line.times > 0, 'Invalid purchase quantity')
            const item = catalog.item(shop.config, line.slot_id, c.state, c.now)
            ensure(item.goods.goodsId === line.goods_id, 'Wrong goods for slot')
            ensure(item.in_time, 'Goods are outside their time window', ErrorCode.ShopItemNotInTime)
            ensure(item.unlocked, 'Goods are locked', ErrorCode.ShopItemUnlock)
            const entry = basket.get(line.slot_id) || { ...item, times: 0 }
            entry.times += line.times
            ensure(Number.isSafeInteger(entry.times) && entry.times <= 0xffffffff, 'Purchase quantity overflow')
            basket.set(line.slot_id, entry)
        }
        const costs = new Map(),
            plans = []
        for (const item of basket.values()) {
            ensure(
                item.goods.goodsNum <= 0 || item.bought + item.times <= item.goods.goodsNum,
                'Purchase limit exceeded',
            )
            ensure(item.bought + item.times <= 0xffffffff, 'Purchase counter overflow')
            for (const cost of parseRewards(item.goods.costId, true)) {
                if (cost.itemnum === 0) continue
                ensure([3, 10].includes(cost.itemtype), 'Unsupported shop payment', ErrorCode.InvalidProtoID)
                const key = `${cost.itemtype}:${cost.itemid}`,
                    n = (costs.get(key) || 0) + cost.itemnum * item.times
                ensure(Number.isSafeInteger(n) && n <= 0xffffffff, 'Purchase cost overflow')
                costs.set(key, n)
            }
            const rewards = parseRewards(item.goods.item).map((x) => ({ ...x, itemnum: x.itemnum * item.times }))
            ensure(
                rewards.length &&
                    rewards.every((x) => Number.isSafeInteger(x.itemnum) && x.itemnum > 0 && x.itemnum <= 0xffffffff),
                'Invalid shop reward',
                ErrorCode.GameConfig,
            )
            ensure(!item.goods.autoOpen, 'Auto-opening goods require reward-pool support', ErrorCode.InvalidProtoID)
            plans.push({ item, rewards })
        }
        const bag = new Map()
        for (const [key, n] of costs) {
            const [type, id] = key.split(':').map(Number)
            if (type === 3) bag.set(id, n)
            else spendCurrency(c.state, id, n)
        }
        if (bag.size) spend(c.state, bag, 0, c.now)
        c.state.shopPurchases ??= {}
        const rewards = []
        for (const plan of plans) {
            rewards.push({ rewards: grantRewards(tables, c.state, plan.rewards) })
            c.state.shopPurchases[plan.item.key] = {
                period: plan.item.window.start,
                count: plan.item.bought + plan.item.times,
            }
        }
        syncPlayer(c)
        c.push('SCProtoShopInfoSync', { shop_id: r.shop_id, shop_info: catalog.info(r.shop_id, c.state, c.now) })
        return { shop_id: r.shop_id, rewards }
    })
}
