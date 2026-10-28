import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'
import { spend } from './inventory.js'
import { requireBattlePass } from './battle-pass.js'
import { battlePassLevelInfo } from './battle-pass-buy-level.js'
import { activateMonthlyEntitlement, activateBattlePassEntitlement } from './entitlement-benefits.js'
import { monthlyPayload } from './monthly-card.js'
import { notifyRechargePopup } from './mall-popup.js'
import { rewardSource } from './reward-source.js'

const specs = [
    {
        useType: 21,
        type: 1201,
        itemKey: 'MONTHLY_CARD_EXCHANGE_ITEM_ID',
        sdkKey: 'MONTHLY_CADR_PURCHASE_SDK_ID',
        mode: 'monthly',
        system: 64,
    },
    {
        useType: 22,
        type: 1202,
        itemKey: 'BATTLEPASS_ADV_EXCHANGE_ITEM_ID',
        sdkKey: 'BATTLEPASS_PURCHASE_SDK_ID_ADV',
        mode: 'advanced',
        system: 65,
    },
    {
        useType: 23,
        type: 1203,
        itemKey: 'BATTLEPASS_LUXURY_EXCHANGE_ITEM_ID',
        sdkKey: 'BATTLEPASS_PURCHASE_SDK_ID_LUXURY',
        mode: 'luxury',
        system: 65,
    },
]
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
export const isEntitlementTicket = (item) => specs.some((s) => s.useType === item?.useType)
function configuration(c, item) {
    const spec = specs.find((s) => s.useType === item.useType)
    const constant = (key) => {
        const rows = c.tables.get('mall_game').filter((r) => r.title === key)
        ensure(
            rows.length === 1 && /^[1-9]\d*$/.test(String(rows[0].value)),
            'Invalid entitlement constant',
            ErrorCode.GameConfig,
        )
        const id = Number(rows[0].value)
        ensure(uint(id) && id > 0, 'Invalid entitlement identity', ErrorCode.GameConfig)
        return id
    }
    const itemId = constant(spec.itemKey),
        sdkId = constant(spec.sdkKey)
    ensure(
        item.id === itemId &&
            item.type === spec.type &&
            item.stackNum === 1 &&
            !item.useFunction &&
            !item.giftBagReward,
        'Invalid ticket item configuration',
        ErrorCode.GameConfig,
    )
    ensure(c.tables.find('purchase_sdk', sdkId), 'Missing entitlement display identity', ErrorCode.GameConfig)
    const system = c.tables.find('system_unlock', spec.system)
    ensure(
        system && typeof system.unlockCondi === 'string',
        'Missing ticket system configuration',
        ErrorCode.GameConfig,
    )
    ensure(
        homeCondition(system.unlockCondi, c.state),
        'Entitlement system is locked',
        spec.mode === 'monthly' ? ErrorCode.MonthlyCardSysLock : ErrorCode.SystemLock,
    )
    return { spec, sdkId }
}
function monthlyConfiguration(c, sdkId) {
    const config = c.tables.find('monthly_card', sdkId),
        previous = c.state.monthlyCard
    ensure(
        config &&
            config.purchaseSdkID === sdkId &&
            uint(config.day) &&
            config.day > 0 &&
            uint(config.maxDay) &&
            config.maxDay > 0,
        'Invalid monthly ticket configuration',
        ErrorCode.GameConfig,
    )
    ensure(
        !previous ||
            (object(previous) &&
                uint(previous.config_id) &&
                previous.purchase_sdk_id === sdkId &&
                Number.isSafeInteger(previous.end_time) &&
                previous.end_time >= 0 &&
                Number.isSafeInteger(previous.claim_until) &&
                previous.claim_until >= 0),
        'Invalid saved monthly entitlement',
        ErrorCode.GameConfig,
    )
    const days = Math.floor(Math.max(0, (previous?.end_time ?? 0) - Math.ceil(c.now)) / 86400)
    // The current client checks remaining whole days before adding this ticket.
    // This is not a guessed cap on the resulting extended end time.
    ensure(days < config.maxDay, 'Monthly ticket remaining-day limit', ErrorCode.MonthlyCardMaxLimit)
    return config
}
function sourceLedger(state) {
    const saved = state.entitlementTickets
    ensure(
        saved === undefined || (object(saved) && saved.version === 1 && Array.isArray(saved.receipts)),
        'Invalid item entitlement ledger',
        ErrorCode.GameConfig,
    )
    const receipts = saved?.receipts ?? [],
        ids = new Set()
    for (const receipt of receipts) {
        ensure(
            object(receipt) &&
                uint(receipt.receipt_id) &&
                receipt.receipt_id > 0 &&
                uint(receipt.item_id) &&
                receipt.item_id > 0 &&
                ['monthly', 'advanced', 'luxury'].includes(receipt.mode) &&
                receipt.count === 1 &&
                Number.isSafeInteger(receipt.applied_at) &&
                receipt.applied_at >= 0 &&
                !ids.has(receipt.receipt_id),
            'Invalid item entitlement receipt',
            ErrorCode.GameConfig,
        )
        ids.add(receipt.receipt_id)
    }
    return saved ?? { version: 1, receipts: [] }
}
export function useEntitlementTicket(c, r, store) {
    ensure(
        r.num === 1 && !r.args?.length,
        'Ticket use requires one item and no arguments',
        r.num === 0 ? ErrorCode.UseItemSendNumZero : ErrorCode.UseItemArgFail,
    )
    ensure(Number.isSafeInteger(c.now) && c.now >= 0, 'Invalid entitlement clock', ErrorCode.GameConfig)
    const item = c.tables.find('common_item', r.itemid),
        { spec, sdkId } = configuration(c, item)
    const source = sourceLedger(c.state)
    const mall = c.state.mall
    ensure(
        mall === undefined || (object(mall) && (mall.popupQueue === undefined || Array.isArray(mall.popupQueue))),
        'Invalid entitlement presentation queue',
        ErrorCode.GameConfig,
    )
    const config = spec.mode === 'monthly' ? monthlyConfiguration(c, sdkId) : null
    const prepared = spec.mode === 'monthly' ? null : requireBattlePass(c)
    // Only the purchase wrapper can select upgrade. Both current ticket callers
    // reject either already-owned premium tier, including luxury after advanced.
    spend(c.state, new Map([[item.id, 1]]), 0, c.now)
    const result = config
        ? activateMonthlyEntitlement(c, config, 1)
        : activateBattlePassEntitlement(c, spec.mode, prepared, 'commonItemUse')
    // The legacy sequence name identifies presentation receipts, not payment
    // orders. Sharing its domain prevents collision with an existing paid FIFO.
    let popupId
    try {
        popupId = store.nextSequence('offline-popup')
    } catch (error) {
        // Store's bounded allocator has one explicit exhaustion branch. Preserve
        // unexpected SQL failures; only that known identity fault is GameConfig.
        if (error.message === 'Sequence exhausted')
            ensure(false, 'Entitlement presentation identity exhausted', ErrorCode.GameConfig)
        throw error
    }
    ensure(
        uint(popupId) && popupId > 0 && !source.receipts.some((x) => x.receipt_id === popupId),
        'Entitlement presentation identity overflow',
        ErrorCode.GameConfig,
    )
    const popup = { popup_id: popupId, pay_source: 0, purchase_sdk_id: sdkId }
    // pay_source0 is the existing explicit local non-web presentation policy.
    // No localOrders/recharges/purchases/premiumOrders are manufactured here.
    if (config) {
        popup.monthly_card_data = { rewards: { ...result.rewards, src: rewardSource(c.tables, 'commonItemUse') } }
        c.pushBefore('SCProtoMonthlyCardInfoSync', monthlyPayload(c.state, result.first))
    } else {
        popup.battlepass_data = result.data
        c.pushBefore('SCProtoBattlePassLevelExpPaySync', battlePassLevelInfo(prepared.season, prepared.ledger))
        c.pushBefore('SCProtoBattlePassPayRewards', result.data)
    }
    source.receipts.push({
        receipt_id: popupId,
        item_id: item.id,
        count: 1,
        mode: spec.mode,
        applied_at: c.now,
        ...(config ? { config_id: config.id, end_time: c.state.monthlyCard.end_time } : { season_key: prepared.key }),
    })
    c.state.entitlementTickets = source
    c.state.mall ??= {}
    c.state.mall.popupQueue ??= []
    c.state.mall.popupQueue.push(popup)
    notifyRechargePopup(c)
    // The success callback already starts18048 for a monthly ticket. All ticket
    // benefits use that single FIFO presentation, never a second generic card.
    return { rewards: [] }
}
