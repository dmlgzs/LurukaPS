import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
const catalogs = new WeakMap()
const operations = new Set([
    'CSProtoNonMallCreatePayOrder',
    'CSProtoPlayerMallCreatePayOrder',
    'CSProtoPlayerMallGetPayGoodsList',
    'CSProtoPlayerMallGetDiamondGoodsList',
    'CSProtoMallGetNovicePackReward',
])
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
function catalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const shops = tables.get('mall_shop').filter(
        (r) =>
            String(r.ModulePath ?? '')
                .split('/')
                .at(-1) === 'ModuleShopSpecialGift.prefab',
    )
    ensure(shops.length === 1, 'Novice pack shop mapping is missing or ambiguous', ErrorCode.MallConfigError)
    const shop = shops[0],
        params = String(shop.param).split('#').map(Number),
        goodsIds = String(shop.goodsListPurchase).split('|').filter(Boolean).map(Number)
    ensure(
        params.length === 2 && params.every((v) => uint(v) && v > 0) && goodsIds.length === 1,
        'Invalid novice pack shop parameters',
        ErrorCode.MallConfigError,
    )
    const [id, groupId] = params,
        goods = tables.get('mall_pay_goods').find((r) => r.goodsId === goodsIds[0])
    ensure(
        goods && tables.find('purchase_sdk', goods.purchaseSdkID),
        'Missing novice pack purchase configuration',
        ErrorCode.MallConfigError,
    )
    ensure(
        !shop.timelimit && !shop.unlockCondition && !goods.timelimit && !goods.commonCondition,
        'Scheduled or conditional novice pack requires support',
        ErrorCode.FunctionClosed,
    )
    const rows = tables
        .get('mall_shop_giftpack_login')
        .filter((r) => r.groupId === groupId)
        .sort((a, b) => a.day - b.day)
    ensure(
        rows.length > 0 && rows.every((r, i) => uint(r.id) && r.id > 0 && r.day === i + 1 && r.reward),
        'Invalid novice pack day rewards',
        ErrorCode.MallConfigError,
    )
    ensure(
        new Set(rows.map((r) => r.id)).size === rows.length,
        'Duplicate novice pack reward identity',
        ErrorCode.MallConfigError,
    )
    const resetHour = Number(tables.get('game').find((r) => r.title === 'DAILY_REFRESH_TIME')?.value)
    ensure(
        Number.isInteger(resetHour) && resetHour >= 0 && resetHour < 24,
        'Invalid novice pack reset time',
        ErrorCode.GameConfig,
    )
    const result = { shop, goods, id, groupId, rows, resetHour }
    catalogs.set(tables, result)
    return result
}
function dayKey(data, now) {
    ensure(Number.isSafeInteger(now) && now >= 0, 'Invalid novice pack clock', ErrorCode.GameConfig)
    return Math.floor((now + (8 - data.resetHour) * 3600) / 86400)
}
function paidOrder(data, state) {
    const orders = Object.values(state.mall?.localOrders ?? {}).filter(
        (o) =>
            o.mode === 'offline-simulated' &&
            o.purchase_sdk_id === data.goods.purchaseSdkID &&
            o.gift?.pay_shop_id === data.shop.shopId &&
            o.gift.pay_goods_id === data.goods.goodsId &&
            !o.gift.is_oversold,
    )
    if (!orders.length) return undefined
    ensure(
        orders.every(
            (o) =>
                typeof o.id === 'string' &&
                o.id &&
                Number.isSafeInteger(o.created_at) &&
                o.created_at >= 0 &&
                o.count === 1,
        ),
        'Invalid novice pack payment receipt',
        ErrorCode.GameConfig,
    )
    ensure(
        (state.mall.purchases?.['pay:' + data.goods.goodsId]?.count ?? 0) >= 1,
        'Novice pack order has no delivered entitlement',
        ErrorCode.GameConfig,
    )
    return orders.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0]
}
export function prepareNovicePack(tables, state, now) {
    const data = catalog(tables),
        order = paidOrder(data, state)
    const unbought = {
        id: data.id,
        group_id: data.groupId,
        bought: false,
        login_days: 0,
        already_fetched: [],
        status: 0,
    }
    if (!order) return { payload: unbought, changed: false }
    const key = dayKey(data, now),
        purchased = dayKey(data, order.created_at)
    ensure(key >= purchased, 'Novice pack payment lies in the future', ErrorCode.GameConfig)
    let ledger = state.mall.novicePack,
        changed = false
    if (!ledger) {
        ledger = {
            id: data.id,
            groupId: data.groupId,
            goodsId: data.goods.goodsId,
            orderId: order.id,
            status: 1,
            loginDays: [purchased],
            claimedIds: [],
        }
        state.mall.novicePack = ledger
        changed = true
    }
    ensure(
        ledger.id === data.id &&
            ledger.groupId === data.groupId &&
            ledger.goodsId === data.goods.goodsId &&
            ledger.orderId === order.id &&
            [1, 2].includes(ledger.status),
        'Invalid saved novice pack entitlement',
        ErrorCode.GameConfig,
    )
    ensure(
        Array.isArray(ledger.loginDays) &&
            ledger.loginDays.length > 0 &&
            ledger.loginDays.every((d) => Number.isSafeInteger(d) && d >= purchased && d <= key) &&
            new Set(ledger.loginDays).size === ledger.loginDays.length,
        'Invalid novice pack login history',
        ErrorCode.GameConfig,
    )
    ensure(
        Array.isArray(ledger.claimedIds) &&
            ledger.claimedIds.every((id) => data.rows.some((r) => r.id === id)) &&
            new Set(ledger.claimedIds).size === ledger.claimedIds.length,
        'Invalid novice pack claim history',
        ErrorCode.GameConfig,
    )
    ensure(
        ledger.loginDays.includes(purchased) &&
            ledger.claimedIds.every((id) => data.rows.find((r) => r.id === id).day <= ledger.loginDays.length),
        'Novice pack history contains an unearned login reward',
        ErrorCode.GameConfig,
    )
    // Observe actual signed-in activity, never count untouched offline dates.
    // Old receipts prove the purchase day; missing historical logins are not invented.
    if (ledger.status === 1 && ledger.loginDays.length < data.rows.length && !ledger.loginDays.includes(key)) {
        ledger.loginDays.push(key)
        changed = true
    }
    return {
        payload: {
            id: data.id,
            group_id: data.groupId,
            bought: true,
            login_days: ledger.loginDays.length,
            already_fetched: [...ledger.claimedIds].sort((a, b) => a - b),
            status: ledger.status,
        },
        changed,
    }
}
export function notifyNovicePack(c, name) {
    if (!operations.has(name)) return
    const result = prepareNovicePack(c.tables, c.state, c.now)
    if (result.changed) c.pushBefore('SCProtoMallNovicePackSync', result.payload)
}
export function claimNovicePack(c, day) {
    const data = catalog(c.tables),
        row = data.rows.find((r) => r.day === day)
    ensure(row, 'Unknown novice pack login day', ErrorCode.InvalidArgument)
    const prepared = prepareNovicePack(c.tables, c.state, c.now)
    ensure(
        prepared.payload.bought && prepared.payload.status === 1,
        'Novice pack is not purchased or active',
        ErrorCode.MallGoodsDynamicCondInvalid,
    )
    const ledger = c.state.mall.novicePack
    if (ledger.claimedIds.includes(row.id)) {
        c.pushBefore('SCProtoMallNovicePackSync', prepared.payload)
        return { rewards: [] }
    }
    ensure(
        prepared.payload.login_days >= row.day,
        'Novice pack login day is not reached',
        ErrorCode.MallGoodsDynamicCondInvalid,
    )
    const rewards = grantRewards(c.tables, c.state, parseRewards(row.reward))
    ledger.claimedIds.push(row.id)
    const source = rewardSource(c.tables, 'novicePackReward')
    c.pushBefore('SCProtoMallNovicePackSync', prepareNovicePack(c.tables, c.state, c.now).payload)
    return { ...(source === undefined ? {} : { src: source }), rewards }
}
export function registerNovicePack(on) {
    on('MallGetNovicePackReward', (c, r) => claimNovicePack(c, r.u32))
}
