import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { refreshWindow } from './shops.js'
import { mallConditions } from './mall-conditions.js'
import { mallTableRow, mallSchedule } from './mall-schedule.js'
export class MallCatalog {
    constructor(tables) {
        this.tables = tables
        this.shops = new Map(tables.get('mall_shop').map((x) => [x.shopId, x]))
        this.pay = new Map(tables.get('mall_pay_goods').map((x) => [x.goodsId, mallTableRow('mall_pay_goods', x)]))
        this.diamond = new Map(tables.get('mall_goods').map((x) => [x.goodsId, x]))
    }
    goods(isPay, id, state, now) {
        const row = (isPay ? this.pay : this.diamond).get(id)
        ensure(row, 'Unknown mall goods')
        const { start, end } = mallSchedule(this.tables, row.timelimit)
        const period = this.window(row, now)
        const record = state.mall?.purchases?.[`${isPay ? 'pay' : 'diamond'}:${id}`],
            count = record?.period === period.start ? record.count : 0
        const condition = mallConditions(this.tables, state, row.commonCondition)
        return {
            is_pay_goods: isPay,
            goods_id: id,
            begin_time: String(start),
            end_time: String(end),
            curr_purchase_num: count,
            reset_time: String(period.end),
            unlock_cond_id: condition.ids,
            unlock_progress: condition.progress,
            is_all_cond_done: condition.passed,
        }
    }
    window(row, now) {
        let refreshTypeParam = row.refreshTypeParam
        if (row.refreshType === 4 && String(refreshTypeParam).includes('|')) {
            const parts = String(refreshTypeParam).split('|').map(Number)
            ensure(parts.length === 3 && parts.every(Number.isInteger), 'Invalid mall refresh time')
            refreshTypeParam = parts[0] * 10000 + parts[1] * 100 + parts[2]
        }
        return row.refreshType === 0 ? { start: 0, end: 0 } : refreshWindow({ ...row, refreshTypeParam }, now)
    }
    list(isPay, shopId, goodsId, state, now) {
        const catalog = isPay ? this.pay : this.diamond
        let ids
        if (shopId) {
            const shop = this.shops.get(shopId)
            ensure(shop, 'Unknown mall shop')
            ids = String(isPay ? shop.goodsListPurchase : shop.goodsList)
                .split('|')
                .filter(Boolean)
                .map(Number)
        } else ids = [...catalog.keys()]
        if (goodsId) {
            ensure(ids.includes(goodsId), 'Mall goods do not belong to shop')
            ids = [goodsId]
        }
        return ids.map((id) => this.goods(isPay, id, state, now))
    }
}
