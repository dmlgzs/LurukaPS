import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { battlePassModel, requireBattlePass } from './battle-pass.js'
import { activateBattlePassEntitlement } from './entitlement-benefits.js'
const modes = [
    ['BATTLEPASS_PURCHASE_SDK_ID_ADV', 'advanced'],
    ['BATTLEPASS_PURCHASE_SDK_ID_LUXURY', 'luxury'],
    ['BATTLEPASS_PURCHASE_SDK_ID_UP', 'upgrade'],
]
const sdkModes = new WeakMap()
export function battlePassPurchaseMode(tables, id) {
    if (!sdkModes.has(tables)) {
        const values = new Map(tables.get('mall_game').map((row) => [row.title, row.value]))
        sdkModes.set(tables, new Map(modes.map(([name, mode]) => [Number(values.get(name)), mode])))
    }
    // Unrelated monthly/recharge products do not load or depend on battle-pass
    // season configuration; compile the full catalogue only for a real match.
    return sdkModes.get(tables).get(id) ?? null
}
export function purchaseBattlePass(c, sdk, count, orderId) {
    const mode = battlePassPurchaseMode(c.tables, sdk.id)
    ensure(mode, 'Battle pass purchase product is not configured', ErrorCode.BattlePassConfInvalid)
    ensure(count === 1, 'Battle pass entitlement purchase count must be one')
    const prepared = requireBattlePass(c),
        { ledger } = prepared,
        model = battlePassModel(c.tables),
        ids = modes.map(([name]) => Number(model.constants.get(name)))
    ensure(
        ids.every((n) => Number.isSafeInteger(n) && n > 0) &&
            new Set(ids).size === ids.length &&
            typeof sdk.itemId === 'string' &&
            sdk.itemId.length > 0,
        'Invalid battle pass SDK configuration',
        ErrorCode.BattlePassConfInvalid,
    )
    const result = activateBattlePassEntitlement(c, mode, prepared)
    ledger.premiumOrders ??= []
    ledger.premiumOrders.push({
        order_id: orderId,
        purchase_sdk_id: sdk.id,
        sdk_item_id: sdk.itemId,
        time: c.now,
        mode,
    })
    return { season_key: result.season_key, sdk_item_id: sdk.itemId, data: result.data }
}
