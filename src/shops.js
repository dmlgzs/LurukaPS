import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const zone = 8 * 3600
export function configTime(value) {
    if (!value) return 0
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(value)
    ensure(m, 'Invalid shop date', ErrorCode.GameConfig)
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
    const n = Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - zone
    const date = new Date((n + zone) * 1000)
    ensure(
        date.getUTCFullYear() === y &&
            date.getUTCMonth() === mo - 1 &&
            date.getUTCDate() === d &&
            h < 24 &&
            mi < 60 &&
            s < 60,
        'Invalid shop date',
        ErrorCode.GameConfig,
    )
    return n
}
export function refreshWindow(goods, now, hour = 4) {
    const local = new Date((now + zone) * 1000),
        y = local.getUTCFullYear(),
        mo = local.getUTCMonth(),
        d = local.getUTCDate()
    let start, end
    const at = (year, month, day, h = hour, mi = 0, s = 0) => Date.UTC(year, month, day, h, mi, s) / 1000 - zone
    switch (goods.refreshType) {
        case 1:
            return { start: 0, end: 0 }
        case 3: {
            const day = Number(goods.refreshTypeParam)
            ensure(
                Number.isInteger(day) && day >= 1 && day <= 28,
                'Unsupported monthly reset day',
                ErrorCode.GameConfig,
            )
            start = at(y, mo, day)
            if (now < start) {
                end = start
                start = at(y, mo - 1, day)
            } else end = at(y, mo + 1, day)
            break
        }
        case 4: {
            const raw = Number(goods.refreshTypeParam),
                h = Math.floor(raw / 10000),
                mi = Math.floor(raw / 100) % 100,
                s = raw % 100
            ensure(
                Number.isInteger(raw) && h >= 0 && h < 24 && mi < 60 && s < 60,
                'Invalid daily reset time',
                ErrorCode.GameConfig,
            )
            start = at(y, mo, d, h, mi, s)
            if (now < start) start -= 86400
            end = start + 86400
            break
        }
        case 5: {
            const weekday = Number(goods.refreshTypeParam)
            ensure(
                Number.isInteger(weekday) && weekday >= 1 && weekday <= 7,
                'Invalid weekly reset day',
                ErrorCode.GameConfig,
            )
            const today = local.getUTCDay() || 7
            start = at(y, mo, d) - ((today - weekday + 7) % 7) * 86400
            if (now < start) start -= 604800
            end = start + 604800
            break
        }
        default:
            ensure(false, 'Unsupported shop refresh type', ErrorCode.InvalidProtoID)
    }
    return { start, end }
}
function conditionProgress(text, state) {
    if (!text) return { open: true, values: [] }
    const values = [],
        checks = []
    for (const entry of String(text).split('|')) {
        const [id, target] = entry.split('#').map(Number)
        let value = 0,
            known = true
        if (id === 2004) value = state.player.basic_info.lv
        else if (id === 2007)
            value = (state.taskRecords || []).some((t) => t.task_id === target && t.count > 0) ? target : 0
        else known = false
        values.push(value)
        checks.push(known && value >= target)
    }
    return { open: checks.every(Boolean), values }
}
export class ShopCatalog {
    constructor(tables) {
        this.tables = tables
        this.shops = new Map(tables.get('shop').map((s) => [s.shopId, s]))
        this.slots = new Map(tables.get('shop_slot').map((s) => [s.slotId, s]))
        this.goods = new Map(tables.get('goods').map((g) => [g.goodsId, g]))
        this.hour = Number(tables.get('game').find((x) => x.title === 'DAILY_REFRESH_TIME')?.value ?? 4)
    }
    schedule(row) {
        const launch = row.launchType ?? 0
        ensure(Number.isInteger(launch) && launch >= 0, 'Invalid shop launch type', ErrorCode.GameConfig)
        ensure([0, 1].includes(launch), 'Shop launch type is not supported', ErrorCode.InvalidLogic)
        const limitId = row.timelimit ?? 0
        ensure(Number.isInteger(limitId) && limitId >= 0, 'Invalid shop time limit reference', ErrorCode.GameConfig)
        const limit = limitId ? this.tables.get('common_timelimit').find((entry) => entry.id === limitId) : null
        // Missing exported calendar rows may use the shop/goods' own explicit
        // dates. Do not invent or extend an activity's open period.
        const startText = limit?.startTime || row.startTime
        const endText = limit?.endTime || row.endTime
        ensure(!limitId || startText || endText, 'Shop schedule configuration unavailable', ErrorCode.GameConfig)
        const start = configTime(startText),
            end = configTime(endText)
        ensure(!start || !end || start < end, 'Invalid shop schedule interval', ErrorCode.GameConfig)
        return { start, end }
    }
    shop(id, state, now) {
        const shop = this.shops.get(id)
        ensure(shop, 'Unknown shop', ErrorCode.ShopConfNotExist)
        ensure(conditionProgress(shop.unlockCondition, state).open, 'Shop is locked', ErrorCode.ShopNotOpen)
        const { start, end } = this.schedule(shop)
        const open = (!start || now >= start) && (!end || now < end)
        return { config: shop, start, end, open }
    }
    item(shop, id, state, now) {
        ensure(String(shop.goodsList).split('|').map(Number).includes(id), 'Slot does not belong to this shop')
        const slot = this.slots.get(id)
        ensure(slot?.slotType === 1, 'Unsupported shop slot type', ErrorCode.InvalidProtoID)
        const goods = this.goods.get(slot.slotParam)
        ensure(goods, 'Missing shop goods', ErrorCode.ShopGoodsConfNotExist)
        ensure(
            !goods.specialPrice && !goods.recommend,
            'Special pricing is not yet supported',
            ErrorCode.InvalidProtoID,
        )
        const { start, end } = this.schedule(goods)
        const window = refreshWindow(goods, now, this.hour),
            key = `${shop.shopId}:${id}`,
            record = state.shopPurchases?.[key]
        const bought = record?.period === window.start ? record.count : 0
        ensure(Number.isInteger(goods.goodsNum) && goods.goodsNum >= -1, 'Invalid shop stock', ErrorCode.GameConfig)
        const inTime = (!start || now >= start) && (!end || now < end)
        const unlock = conditionProgress(goods.commonCondition, state)
        return {
            goods,
            key,
            window,
            bought,
            in_time: inTime,
            unlocked: unlock.open,
            open: inTime && unlock.open,
            wire: {
                slot_id: id,
                goods_id: goods.goodsId,
                shop_store_num: Math.max(0, goods.goodsNum),
                buy_times: bought,
                dead_time: window.end,
                begin_time: start,
                end_time: end,
                unlock_progress: unlock.values,
            },
        }
    }
    info(id, state, now) {
        const shop = this.shop(id, state, now)
        const items = String(shop.open ? shop.config.goodsList || '' : '')
            .split('|')
            .filter(Boolean)
            .map(Number)
            .map((slot) => this.item(shop.config, slot, state, now).wire)
        return { shop_id: id, shop_items: items, begin_time: shop.start, end_time: shop.end }
    }
}
