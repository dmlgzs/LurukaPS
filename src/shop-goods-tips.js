import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

// CBT3 ShopStore stores read SLOT IDs, not goods IDs or unread/red-dot flags.
// LOCAL persistence policy: filter read receipts by current fixed-slot goods
// identity, and do not reset them merely because stock refreshed. Client methods
// 06018c49/06018c4b/06018c4c prove wire semantics, not the official server's cycle
// policy. TODO: verify official periodic full-sync/reset behavior.
export class ShopGoodsTips {
    constructor(tables) {
        const index = (name, key) => {
            const rows = tables.get(name)
            ensure(rows.every((row) => uint(row[key])), `Invalid ${name} identity`, ErrorCode.GameConfig)
            const result = new Map(rows.map((row) => [row[key], row]))
            ensure(result.size === rows.length, `Duplicate ${name} identity`, ErrorCode.GameConfig)
            return result
        }
        this.shops = index('shop', 'shopId')
        this.slots = index('shop_slot', 'slotId')
        this.goods = index('goods', 'goodsId')
    }
    members(shop) {
        const values = String(shop.goodsList || '').split('|').filter(Boolean).map(Number)
        ensure(values.every(uint), 'Invalid shop slot list', ErrorCode.GameConfig)
        return values
    }
    ledger(state) {
        if (state.shopGoodsTips === undefined) return {}
        const records = state.shopGoodsTips
        ensure(object(records), 'Invalid shop tip ledger', ErrorCode.GameConfig)
        for (const [slot, entry] of Object.entries(records)) {
            ensure(
                uint(Number(slot)) && String(Number(slot)) === slot && object(entry) &&
                    uint(entry.shop_id) && uint(entry.goods_id),
                'Invalid shop tip record', ErrorCode.GameConfig,
            )
        }
        return records
    }
    read(state, request) {
        const { shop_id: shopId, slot_id: slotId, goods_id: goodsId } = request
        ensure([shopId, slotId, goodsId].every(uint), 'Invalid shop tip identity', ErrorCode.InvalidArgument)
        const shop = this.shops.get(shopId)
        ensure(shop, 'Unknown shop', ErrorCode.ShopConfNotExist)
        const slot = this.slots.get(slotId)
        ensure(slot && this.members(shop).includes(slotId), 'Slot does not belong to this shop', ErrorCode.InvalidArgument)
        ensure(slot.slotType === 1, 'Random shop slot assignment is not implemented', ErrorCode.InvalidProtoID)
        ensure(uint(slot.slotParam), 'Invalid fixed shop slot goods', ErrorCode.GameConfig)
        const goods = this.goods.get(slot.slotParam)
        ensure(goods, 'Missing shop goods', ErrorCode.ShopGoodsConfNotExist)
        ensure(goods.goodsId === goodsId, 'Wrong goods for shop slot', ErrorCode.InvalidArgument)
        const records = this.ledger(state)
        state.shopGoodsTips = { ...records, [slotId]: { shop_id: shopId, goods_id: goodsId } }
        return this.snapshot(state)
    }
    snapshot(state) {
        const tipInfos = []
        for (const [key, entry] of Object.entries(this.ledger(state))) {
            const slotId = Number(key), shop = this.shops.get(entry.shop_id), slot = this.slots.get(slotId)
            // Removed products/stores and changed assignments are no longer read.
            // Retain their receipts internally; never trust stale saved IDs as a
            // current assignment, and never substitute goods ID for slot ID.
            if (shop && slot?.slotType === 1 && slot.slotParam === entry.goods_id &&
                this.goods.has(entry.goods_id) && this.members(shop).includes(slotId)) tipInfos.push(slotId)
        }
        return { tipInfos: tipInfos.sort((a, b) => a - b), isAll: true }
    }
}
