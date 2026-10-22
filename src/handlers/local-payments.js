import { battlePassPurchaseMode, purchaseBattlePass } from '../battle-pass-purchase.js'
import { prepareBattlePass } from '../battle-pass.js'
import { battlePassLevelInfo } from '../battle-pass-buy-level.js'
import { ErrorCode, LocalErrorCode } from '../error-codes.js'
import { monthlyPayload, purchaseMonthly } from '../monthly-card.js'
// Client callback sentinel closes the order mask without opening the SDK.
export const LOCAL_CALLBACK_NOTICE = LocalErrorCode.OfflinePaymentCallback
import { ensure, syncPlayer } from './common.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { MallCatalog } from '../mall.js'
import { payGoodsPlan } from '../mall-pay-goods.js'
import { createHash } from 'node:crypto'
export function registerLocalPayments(on, tables, store, { enabled = true } = {}) {
    const catalog = new MallCatalog(tables)
    const handle = (c, input, isMall = false) => {
        let r = input
        if (isMall) {
            const goods = catalog.pay.get(input.pay_goods_id),
                shop = catalog.shops.get(input.pay_shop_id)
            ensure(shop, 'Mall shop does not exist', ErrorCode.MallShopNotExist)
            ensure(
                goods && String(shop.goodsListPurchase).split('|').map(Number).includes(goods.goodsId),
                'Mall goods do not belong to shop',
                ErrorCode.MallGoodsNotExist,
            )
            r = { ...input, purchase_sdk_id: goods.purchaseSdkID }
        }
        ensure(enabled, 'Offline payments are disabled', ErrorCode.FunctionClosed)
        const match = /^(?:lurukaps|azurjs)-offline:([a-z0-9-]{8,64}):(.*)$/i.exec(r.product_id ?? '')
        const product = match?.[2] ?? r.product_id ?? ''
        ensure(product.length <= 512, 'Product metadata too long')
        ensure(match || c.requestKey, 'Order request has no stable sequence')
        const sdk = tables.find('purchase_sdk', r.purchase_sdk_id)
        ensure(sdk, 'Unknown purchase product', isMall ? ErrorCode.MallConfigError : ErrorCode.InvalidArgument)
        const count = r.buy_count ?? 1
        ensure(Number.isInteger(count) && count >= 1, 'Invalid purchase count', ErrorCode.InvalidArgument)
        ensure(count <= 100, 'Invalid purchase count', isMall ? ErrorCode.MallBuyCountError : ErrorCode.InvalidArgument)
        ensure((r.amount ?? '').length <= 64, 'Invalid amount metadata')
        const mall = (c.state.mall ??= {}),
            orders = (mall.localOrders ??= {}),
            nonce = match?.[1] ?? createHash('sha256').update(c.requestKey).digest('hex'),
            fingerprint = createHash('sha256')
                .update(
                    JSON.stringify([
                        sdk.id,
                        count,
                        product,
                        r.amount ?? '',
                        ...(isMall ? ['mall', r.pay_shop_id, r.pay_goods_id] : []),
                    ]),
                )
                .digest('hex')
        const previous = orders[nonce]
        const notify = (order) => {
            c.push(isMall ? 'SCProtoPlayerMallCreatePayOrderNtf' : 'SCProtoNonMallCreatePayOrderNtf', {
                errcode: LOCAL_CALLBACK_NOTICE,
                order_id: order.id,
                purchase_sdk_id: 0,
                purchase_sdk_item: 'lurukaps-offline',
                buy_count: count,
                ext_info: 'offline-simulated',
                ...(isMall ? { pay_shop_id: r.pay_shop_id, pay_goods_id: r.pay_goods_id } : {}),
            })
            if (order.recharge) c.push('SCProtoPlayerMallGetRechargeDiamondNtf', order.recharge)
            if (order.gift) c.push('SCProtoPlayerMallPaySuccessNtf', order.gift)
            if (order.monthly) c.push('SCProtoMonthlyCardInfoSync', monthlyPayload(c.state, order.monthly.first))
            if (order.battlepass) {
                const current = prepareBattlePass(tables, c.state, c.now)
                // A replayed old-season order cannot unlock or overwrite a new
                // season, even if its numeric battlepass ID is reused.
                if (current?.key === order.battlepass.season_key) {
                    c.pushBefore(
                        'SCProtoBattlePassLevelExpPaySync',
                        battlePassLevelInfo(current.season, current.ledger),
                    )
                    c.push('SCProtoBattlePassPayRewards', order.battlepass.data)
                }
            }
            if (!isMall)
                c.push('SCProtoPlayerNoMallPaySuccessNtf', {
                    purchase_sdk_id: sdk.id,
                    is_oversold: false,
                    order_id: order.id,
                    send_type: 0,
                })
        }
        if (previous) {
            ensure(previous.fingerprint === fingerprint, 'Offline order nonce reused with different product')
            notify(previous)
            return {}
        }
        // A fulfilled receipt is replayed above without recharging or applying
        // newly changed ownership/quota conditions. Only a NEW mall order runs
        // the shared purchase plan, before reserving any order/popup identity.
        const mallPlan = isMall ? payGoodsPlan(c, { ...input, buy_count: count }, catalog) : null
        const id = String(store.nextSequence('offline-order')),
            popupId = store.nextSequence('offline-popup'),
            rechargeConfig = tables.get('mall_recharge_diamond').find((x) => x.purchaseSdkID === sdk.id)
        const order = {
            id,
            mode: 'offline-simulated',
            created_at: c.now,
            fingerprint,
            purchase_sdk_id: sdk.id,
            count,
            requested_amount: r.amount ?? '',
            product_id: product,
        }
        const monthlyConfig =
            tables.get('monthly_card').find((x) => x.purchaseSdkID === sdk.id && x.id === sdk.id) ??
            tables.get('monthly_card').find((x) => x.purchaseSdkID === sdk.id)
        let popup
        if (!isMall && battlePassPurchaseMode(tables, sdk.id)) {
            order.battlepass = purchaseBattlePass(c, sdk, count, id)
            popup = {
                popup_id: popupId,
                pay_source: 0,
                purchase_sdk_id: sdk.id,
                battlepass_data: order.battlepass.data,
            }
        } else if (monthlyConfig) {
            order.monthly = purchaseMonthly(c, monthlyConfig, count)
            popup = {
                popup_id: popupId,
                pay_source: 0,
                purchase_sdk_id: sdk.id,
                monthly_card_data: { rewards: order.monthly.rewards },
            }
        } else if (rechargeConfig) {
            const records = (mall.recharges ??= []),
                record = records.find((x) => x.purchase_sdk_id === sdk.id),
                first = !record,
                base = rechargeConfig.rechargeDiamondNum * count,
                bonus =
                    (first ? rechargeConfig.firstRechargeBonus : 0) +
                    rechargeConfig.rechargeBonus * (count - (first ? 1 : 0))
            const rewards = grantRewards(c.tables, c.state, [
                { itemtype: 10, itemid: 901, itemnum: base },
                ...(bonus ? [{ itemtype: 10, itemid: 902, itemnum: bonus }] : []),
            ])
            if (record) record.count = (record.count ?? 1) + count
            else records.push({ purchase_sdk_id: sdk.id, first_recharge_time: String(c.now), count })
            order.recharge = {
                purchase_sdk_id: sdk.id,
                buy_count: count,
                recharge_diamond_num: base,
                first_recharge_bonus: first ? rechargeConfig.firstRechargeBonus : 0,
                recharge_bonus: rechargeConfig.rechargeBonus * (count - (first ? 1 : 0)),
                rewards: { rewards },
                first_recharge_time: record?.first_recharge_time ?? String(c.now),
            }
            popup = { popup_id: popupId, pay_source: 0, purchase_sdk_id: sdk.id, recharge_diamond: order.recharge }
        } else {
            const matches = mallPlan
                ? [mallPlan.goods]
                : tables.get('mall_pay_goods').filter((x) => x.purchaseSdkID === sdk.id)
            ensure(matches.length === 1, 'Offline entitlement product is not implemented', ErrorCode.FunctionClosed)
            const goods = matches[0],
                wire = mallPlan?.wire ?? catalog.goods(true, goods.goodsId, c.state, c.now),
                shop =
                    mallPlan?.shop ??
                    tables
                        .get('mall_shop')
                        .find(
                            (s) =>
                                (!isMall || s.shopId === r.pay_shop_id) &&
                                String(s.goodsListPurchase).split('|').map(Number).includes(goods.goodsId),
                        )
            if (!mallPlan) {
                ensure(
                    shop &&
                        wire.is_all_cond_done &&
                        (!Number(wire.begin_time) || c.now >= Number(wire.begin_time)) &&
                        (!Number(wire.end_time) || c.now < Number(wire.end_time)),
                    'Offline gift is unavailable',
                )
                ensure(
                    !goods.goodsNum || wire.curr_purchase_num + count <= goods.goodsNum,
                    'Offline gift purchase limit',
                )
            }
            const rewards = grantRewards(
                c.tables,
                c.state,
                mallPlan?.output ?? parseRewards(goods.item).map((x) => ({ ...x, itemnum: x.itemnum * count })),
            )
            mall.purchases ??= {}
            mall.purchases[`pay:${goods.goodsId}`] = {
                period: catalog.window(goods, c.now).start,
                count: wire.curr_purchase_num + count,
            }
            order.gift = {
                pay_shop_id: shop.shopId,
                pay_goods_id: goods.goodsId,
                pay_rewards: { rewards },
                is_oversold: false,
                order_id: id,
                send_type: 0,
            }
            popup = { popup_id: popupId, pay_source: 0, purchase_sdk_id: sdk.id, mall_data: order.gift }
        }
        orders[nonce] = order
        mall.popupQueue ??= []
        mall.popupQueue.push(popup)
        syncPlayer({ ...c, push: c.pushBefore })
        notify(order)
        return {}
    }
    on('NonMallCreatePayOrder', (c, r) => handle(c, r))
    on('PlayerMallCreatePayOrder', (c, r) => handle(c, r, true))
}
