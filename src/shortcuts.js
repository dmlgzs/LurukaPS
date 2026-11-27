import { readTable } from './table-source.js'
const items = readTable('common_item')
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { compileItemShortcutCompatibility } from './item-shortcut-compatibility.js'

const quickItems = new Set(items.filter((row) => row.isQuickBar === 1).map((row) => row.id))
const compatibility = compileItemShortcutCompatibility(items)
const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff
const slot = (n) => Number.isInteger(n) && n >= 1 && n <= 6

function rows(state) {
    const list = state.itemShortcuts ?? []
    ensure(Array.isArray(list) && list.length <= 6, 'Invalid stored item shortcuts', ErrorCode.GameConfig)
    const used = new Set()
    for (const row of list) {
        ensure(
            row && slot(row.slot_id) && uint(row.item_id) && row.item_id > 0 && !used.has(row.slot_id),
            'Invalid stored item shortcut entry',
            ErrorCode.GameConfig,
        )
        used.add(row.slot_id)
    }
    return list
}

function held(state, id, now) {
    return state.player.sbag_infos.items.some(
        (row) => row.itemid === id && row.itemnum > 0 && (!row.deadtime || row.deadtime > now),
    )
}

export function shortcutSnapshot(state, now) {
    compatibility.validate(state)
    return {
        item_infos: rows(state)
            .filter((row) => quickItems.has(row.item_id) && held(state, row.item_id, now))
            .map((row) => ({ slot_id: row.slot_id, item_id: row.item_id }))
            .sort((a, b) => a.slot_id - b.slot_id),
    }
}

export function pruneItemShortcuts(state, now) {
    if (state.itemShortcuts === undefined) {
        compatibility.validate(state)
        return false
    }
    const current = rows(state),
        archived = compatibility.remember(state, current),
        next = [
            ...shortcutSnapshot(state, now).item_infos,
            ...current.filter((row) => compatibility.retired(row.item_id)),
        ].sort((a, b) => a.slot_id - b.slot_id)
    if (current.length === next.length) return archived
    state.itemShortcuts = next
    return true
}

function requestEntry(row, source = false) {
    ensure(row && uint(row.slot_id ?? 0) && uint(row.item_id ?? 0), 'Invalid shortcut entry')
    const value = { slot_id: row.slot_id ?? 0, item_id: row.item_id ?? 0 }
    ensure(
        slot(value.slot_id) || (source && value.slot_id === 0),
        'Shortcut slot outside client six-slot bar',
        ErrorCode.ShortcutItemSlotInVilid,
    )
    return value
}

function requireHeld(state, id, now) {
    ensure(quickItems.has(id), 'Item is not eligible for the quick item bar', ErrorCode.ShortcutItemType)
    ensure(held(state, id, now), 'Quick item is not owned or has expired', ErrorCode.ItemNotEnough)
}

export function changeItemShortcut(c, r) {
    ensure(r.type === 1, 'Unsupported shortcut key type', ErrorCode.ShortcutItemType)
    const source = requestEntry(r.item?.src_item, true),
        target = r.item?.tar_item == null ? null : requestEntry(r.item.tar_item),
        originalRows = rows(c.state),
        current = new Map(originalRows.map((row) => [row.slot_id, row.item_id]))
    compatibility.validate(c.state)
    ensure(source.item_id > 0, 'Shortcut source item must be nonzero')
    if (source.slot_id === 0) {
        ensure(target && target.item_id === 0, 'Bag insertion requires a target placeholder')
        requireHeld(c.state, source.item_id, c.now)
        // The client sends target.item_id=0 for both empty slots and replacements.
        current.set(target.slot_id, source.item_id)
    } else if (!target) {
        const old = current.get(source.slot_id)
        // Empty repeated removal is harmless; a stale request must not remove a replacement.
        ensure(old === undefined || old === source.item_id, 'Shortcut changed before removal')
        current.delete(source.slot_id)
    } else {
        ensure(
            source.slot_id !== target.slot_id,
            'Shortcut source and target slots are identical',
            ErrorCode.ShortcutItemSlotRepeated,
        )
        requireHeld(c.state, source.item_id, c.now)
        if (target.item_id) requireHeld(c.state, target.item_id, c.now)
        const atSource = current.get(source.slot_id) ?? 0,
            rawTarget = current.get(target.slot_id) ?? 0,
            atTarget = compatibility.retired(rawTarget) ? 0 : rawTarget
        const original = atSource === source.item_id && atTarget === target.item_id
        const repeated = atSource === target.item_id && atTarget === source.item_id
        ensure(original || repeated, 'Shortcut exchange snapshot is stale')
        // An identical replay of an exchange is not applied backwards a second time.
        if (original) {
            if (target.item_id) current.set(source.slot_id, target.item_id)
            else current.delete(source.slot_id)
            current.set(target.slot_id, source.item_id)
        }
    }
    compatibility.remember(c.state, originalRows)
    c.state.itemShortcuts = [...current].map(([slot_id, item_id]) => ({ slot_id, item_id }))
    pruneItemShortcuts(c.state, c.now)
    c.pushBefore('CSProtoShortcutDataSync', shortcutSnapshot(c.state, c.now))
    return {}
}
