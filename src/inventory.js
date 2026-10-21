import { recordNoviceCounter } from './novice-counters.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { syncCurrencyMirrors } from './currency.js'
import { pruneAutoCropShortcuts } from './home.js'
export function upgradeInventory(state) {
    const items = state.player.sbag_infos.items,
        used = new Set()
    let next = BigInt(state.nextItemGuid ?? '1')
    const allocate = () => {
        while (used.has(String(next))) next++
        ensure(next <= 0xffffffffffffffffn, 'Item identity space exhausted')
        const id = String(next++)
        used.add(id)
        return id
    }
    // Reserve all valid existing identities before repairing missing/duplicate ones.
    for (const item of items) {
        const id = String(item.guid ?? '0')
        if (/^\d+$/.test(id) && BigInt(id) > 0n && BigInt(id) <= 0xffffffffffffffffn) used.add(String(BigInt(id)))
    }
    const seen = new Set()
    for (const item of items) {
        let id = String(item.guid ?? '0')
        if (!/^\d+$/.test(id) || BigInt(id) === 0n || BigInt(id) > 0xffffffffffffffffn || seen.has(String(BigInt(id))))
            id = allocate()
        else id = String(BigInt(id))
        item.guid = id
        item.itemtype ??= 3
        seen.add(id)
    }
    for (const id of used) if (BigInt(id) >= next) next = BigInt(id) + 1n
    state.nextItemGuid = String(next)
    state.inventoryVersion = 1
}
export function aggregateCosts(items) {
    ensure(Array.isArray(items) && items.length > 0 && items.length <= 100, 'Invalid item selection')
    const result = new Map()
    for (const item of items) {
        ensure(
            Number.isInteger(item.item_id) && item.item_id > 0 && Number.isInteger(item.item_num) && item.item_num > 0,
            'Invalid item quantity',
        )
        const n = (result.get(item.item_id) || 0) + item.item_num
        ensure(Number.isSafeInteger(n) && n <= 0xffffffff, 'Quantity overflow')
        result.set(item.item_id, n)
    }
    return result
}
export function spend(state, costs, gold = 0, now = Math.floor(Date.now() / 1000)) {
    ensure(Number.isSafeInteger(gold) && gold >= 0, 'Invalid gold cost')
    const bag = state.player.sbag_infos.items
    ensure(state.player.basic_info.gold >= gold, 'Insufficient gold', ErrorCode.ItemNotEnough)
    const plan = []
    for (const [id, count] of costs) {
        const stacks = bag
            .filter((i) => i.itemid === id && (!i.deadtime || i.deadtime > now))
            .sort((a, b) => (a.deadtime || Infinity) - (b.deadtime || Infinity))
        ensure(stacks.reduce((n, i) => n + i.itemnum, 0) >= count, 'Insufficient items', ErrorCode.ItemNotEnough)
        let left = count
        for (const stack of stacks) {
            const take = Math.min(left, stack.itemnum)
            if (take) plan.push([stack, take])
            left -= take
            if (!left) break
        }
    }
    for (const [stack, n] of plan) stack.itemnum -= n
    state.player.basic_info.gold -= gold
    if (plan.length) pruneAutoCropShortcuts(state)
    if (gold) syncCurrencyMirrors(state.player)
    // Zero-count entries are retained for delta synchronization; client removes them.
    return plan.map(([stack]) => ({ ...stack }))
}

export function spendCurrency(state, id, amount) {
    // CBT3 proto_errcode/errorCode: 10015 = ErrCodeItemNotEnough (物品不足).
    // Resource shortages are business failures, not malformed requests (1024).
    ensure(Number.isSafeInteger(amount) && amount > 0, 'Invalid currency cost')
    if (id === 1 || id === 2) {
        const key = id === 1 ? 'diamond' : 'gold'
        ensure(state.player.basic_info[key] >= amount, 'Insufficient currency', ErrorCode.ItemNotEnough)
        state.player.basic_info[key] -= amount
        syncCurrencyMirrors(state.player)
        return
    }
    const attr = state.player.attr_infos.attrs.find((a) => a.attr_id === id)
    ensure(attr && BigInt(attr.attr_val) >= BigInt(amount), 'Insufficient currency', ErrorCode.ItemNotEnough)
    attr.attr_val = String(BigInt(attr.attr_val) - BigInt(amount))
    if (id === 3) recordNoviceCounter(state, 'staminaSpent', amount)
}
export function addItems(state, items) {
    if (state.inventoryVersion !== 1) upgradeInventory(state)
    const bag = state.player.sbag_infos.items
    for (const item of items) {
        ensure(
            Number.isInteger(item.itemid) && item.itemid > 0 && Number.isInteger(item.itemnum) && item.itemnum > 0,
            'Invalid reward',
        )
        let current = bag.find((x) => x.itemid === item.itemid && !x.deadtime)
        if (!current) {
            const guid = BigInt(state.nextItemGuid)
            ensure(guid <= 0xffffffffffffffffn, 'Item identity space exhausted')
            state.nextItemGuid = String(guid + 1n)
            current = { itemid: item.itemid, itemnum: 0, itemtype: 3, guid: String(guid) }
            bag.push(current)
        }
        ensure(current.itemnum + item.itemnum <= 0xffffffff, 'Item count overflow')
        current.itemnum += item.itemnum
    }
}
