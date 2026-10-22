import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { spend, upgradeInventory } from './inventory.js'

const emptySlot = () => ({ item_id: 0, item_num: 0, source_stacks: [] })
export function snackConstant(tables, title) {
    const value = Number(tables.get('game').find((row) => row.title === title)?.value)
    ensure(Number.isSafeInteger(value) && value >= 0, 'Snack bag constant missing: ' + title, ErrorCode.GameConfig)
    return value
}
function bagType(value) {
    ensure(value === 1 || value === 2, 'Unknown snack bag type', ErrorCode.MountSnackTypeError)
    return value
}
function slotIndex(value) {
    ensure(Number.isInteger(value) && value >= 0 && value < 4, 'Invalid snack slot', ErrorCode.MountSnackSlotLimit)
    return value
}
function readBag(tables, state, type, now) {
    const raw = state.snackBags?.[type]
    const num =
        raw?.num ?? snackConstant(tables, type === 1 ? 'SATIETY_AUTOMATIC_USE_MOUNT' : 'SATIETY_AUTOMATIC_USE_ROLE')
    const cap = snackConstant(tables, type === 1 ? 'PET_SATIETY_MAX_VALUE' : 'MAX_CHARGE_SATIETY_VALUE')
    ensure(Number.isSafeInteger(num) && num >= 0 && num <= cap, 'Invalid saved snack threshold', ErrorCode.GameConfig)
    ensure(!raw || raw.items?.length === 4, 'Invalid saved snack bag', ErrorCode.GameConfig)
    return {
        type,
        num,
        items: Array.from({ length: 4 }, (_, index) => {
            const item = raw?.items[index]
            if (!item?.item_num) return emptySlot()
            ensure(
                Number.isSafeInteger(item.item_id) && item.item_id > 0 && Array.isArray(item.source_stacks),
                'Snack provenance missing',
                ErrorCode.GameConfig,
            )
            ensure(
                item.source_stacks.reduce((sum, row) => sum + row.itemnum, 0) === item.item_num,
                'Snack saved count does not match provenance',
                ErrorCode.GameConfig,
            )
            const stacks = item.source_stacks
                .filter((row) => !row.deadtime || row.deadtime > now)
                .map((row) => ({ ...row }))
            const count = stacks.reduce((sum, row) => sum + row.itemnum, 0)
            ensure(
                item.source_stacks.every(
                    (row) =>
                        /^\d+$/.test(row.guid) &&
                        BigInt(row.guid) > 0n &&
                        Number.isSafeInteger(row.itemnum) &&
                        row.itemnum > 0 &&
                        (!row.deadtime || (Number.isSafeInteger(row.deadtime) && row.deadtime > 0)),
                ) && Number.isSafeInteger(count),
                'Invalid snack provenance',
                ErrorCode.GameConfig,
            )
            return count ? { item_id: item.item_id, item_num: count, source_stacks: stacks } : emptySlot()
        }),
    }
}
export function snackBagsSnapshot(tables, state, now = Math.floor(Date.now() / 1000)) {
    return {
        bags: [1, 2].map((type) => {
            const bag = readBag(tables, state, type, now)
            return { ...bag, items: bag.items.map(({ item_id, item_num }) => ({ item_id, item_num })) }
        }),
    }
}
function snack(tables, id, type) {
    // Current PageMountSnackBag.RefreshSnackList uses food.satietyScore > 0.
    // Its old hero-bag counterpart has no positive charge values in CBT3.
    ensure(type === 1, 'Hero snack storage requires current client semantics', ErrorCode.FunctionClosed)
    const item = tables.find('common_item', id)
    ensure(item?.type === 355, 'Snack common-item category mismatch', ErrorCode.MountSnackItemSubTypeError)
    const food = tables.find('food', id)
    ensure(
        Number.isSafeInteger(food?.satietyScore) && food.satietyScore > 0,
        'Item cannot replenish snack satiety',
        ErrorCode.SnackBagInvalidArg,
    )
}
function capture(c, id, count) {
    if (c.state.inventoryVersion !== 1) upgradeInventory(c.state)
    const old = new Map(
        c.state.player.sbag_infos.items.filter((row) => row.itemid === id).map((row) => [row.guid, row.itemnum]),
    )
    return spend(c.state, new Map([[id, count]]), 0, c.now).map((row) => ({
        guid: row.guid,
        itemnum: old.get(row.guid) - row.itemnum,
        ...(row.deadtime ? { deadtime: row.deadtime } : {}),
    }))
}
function restore(c, slot) {
    const byGuid = new Map()
    for (const source of slot.source_stacks) {
        const row = byGuid.get(source.guid)
        if (row) row.itemnum += source.itemnum
        else byGuid.set(source.guid, { ...source })
    }
    for (const source of byGuid.values()) {
        let item = c.state.player.sbag_infos.items.find((row) => row.guid === source.guid)
        ensure(
            !item || (item.itemid === slot.item_id && (item.deadtime || 0) === (source.deadtime || 0)),
            'Snack inventory identity conflict',
            ErrorCode.GameConfig,
        )
        if (!item) {
            item = {
                itemid: slot.item_id,
                itemtype: 3,
                guid: source.guid,
                itemnum: 0,
                ...(source.deadtime ? { deadtime: source.deadtime } : {}),
            }
            c.state.player.sbag_infos.items.push(item)
        }
        ensure(
            Number.isSafeInteger(item.itemnum + source.itemnum) && item.itemnum + source.itemnum <= 0xffffffff,
            'Snack return inventory overflow',
            ErrorCode.GameConfig,
        )
        item.itemnum += source.itemnum
    }
}
export function operateSnackBag(c, r) {
    const type = bagType(r.source_bag),
        index = slotIndex(r.source_slot ?? 0)
    ensure(type === 1, 'Hero snack storage requires current client semantics', ErrorCode.FunctionClosed)
    ensure([0, 1, 2].includes(r.operate_type), 'Unknown snack operation', ErrorCode.SnackBagInvalidArg)
    const bags = Object.fromEntries([1, 2].map((id) => [id, readBag(c.tables, c.state, id, c.now)])),
        bag = bags[type],
        slot = bag.items[index]
    if (r.operate_type === 1) {
        ensure(
            Number.isSafeInteger(r.item_num) && r.item_num > 0,
            'Missing snack addition count',
            ErrorCode.MountSnackItemAddZero,
        )
        snack(c.tables, r.item_id, type)
        const max = snackConstant(c.tables, 'SNACKBAG_SLOT_FOOD_MAX_LIMIT'),
            same = slot.item_id === r.item_id
        ensure(max > 0, 'Invalid snack stack constant', ErrorCode.GameConfig)
        ensure((same ? slot.item_num : 0) + r.item_num <= max, 'Snack slot stack limit', ErrorCode.SnackBagInvalidArg)
        const sources = capture(c, r.item_id, r.item_num)
        if (!same && slot.item_num) restore(c, slot)
        bag.items[index] = {
            item_id: r.item_id,
            item_num: (same ? slot.item_num : 0) + r.item_num,
            source_stacks: [...(same ? slot.source_stacks : []), ...sources],
        }
    } else if (r.operate_type === 0) {
        ensure(!r.item_num && !r.item_id, 'Snack removal uses the whole selected slot', ErrorCode.SnackBagInvalidArg)
        // A repeated removal of an empty slot is harmless and cannot mint food.
        if (slot.item_num) restore(c, slot)
        bag.items[index] = emptySlot()
    } else {
        ensure(!r.item_num && !r.item_id, 'Snack move does not select a new item', ErrorCode.SnackBagInvalidArg)
        const targetType = bagType(r.target_bag),
            targetIndex = slotIndex(r.target_slot ?? 0)
        ensure(targetType === 1, 'Hero snack transfer requires current client semantics', ErrorCode.FunctionClosed)
        const target = bags[targetType].items[targetIndex]
        ensure(slot.item_num > 0, 'Source snack slot is empty', ErrorCode.SnackBagNoItem)
        bags[targetType].items[targetIndex] = slot
        bag.items[index] = target
    }
    c.state.snackBags = bags
    c.pushBefore('CSProtoSyncPlayerData', { sbag_infos: c.state.player.sbag_infos })
    c.pushBefore('CSProtoAllSnackBagInfoSync', snackBagsSnapshot(c.tables, c.state, c.now))
    return {}
}
export function setSnackBagNum(c, r) {
    ensure(
        Array.isArray(r.info) && r.info.length > 0 && r.info.length <= 2,
        'Invalid snack threshold selection',
        ErrorCode.SnackBagInvalidArg,
    )
    const bags = Object.fromEntries([1, 2].map((type) => [type, readBag(c.tables, c.state, type, c.now)])),
        selected = new Set()
    for (const entry of r.info) {
        const type = bagType(entry.bag_type),
            cap = snackConstant(c.tables, type === 1 ? 'PET_SATIETY_MAX_VALUE' : 'MAX_CHARGE_SATIETY_VALUE')
        ensure(!selected.has(type), 'Duplicate snack threshold bag', ErrorCode.SnackBagInvalidArg)
        selected.add(type)
        ensure(
            Number.isSafeInteger(entry.num) && entry.num >= 0 && entry.num <= cap,
            'Snack threshold exceeds satiety maximum',
            ErrorCode.MountSnackNumMaxLimit,
        )
        bags[type].num = entry.num
    }
    c.state.snackBags = bags
    c.pushBefore('CSProtoAllSnackBagInfoSync', snackBagsSnapshot(c.tables, c.state, c.now))
    return {}
}
