import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeBuildingAvailability } from './home-building-availability.js'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const valid = (condition, text) => ensure(condition, text, ErrorCode.GameConfig)
const shortcutPolicyId = 'retired-home-buildings-1.0.0-v1'
const slotId = (id) => Number.isInteger(id) && id >= -1 && id <= 0x7fffffff
function inventory(tables, rows) {
    valid(Array.isArray(rows), 'Home-building inventory presentation is malformed')
    const result = new Map()
    for (const row of rows) {
        valid(
            object(row) &&
                uint(row.build_id) &&
                row.build_id > 0 &&
                uint(row.total_num) &&
                uint(row.used_num) &&
                row.used_num <= row.total_num &&
                typeof row.unlock === 'boolean' &&
                !result.has(row.build_id),
            'Home-building inventory identity or quantity is malformed',
        )
        const availability = homeBuildingAvailability(tables, row.build_id)
        ensure(
            availability.available || row.used_num === 0,
            'Retired furniture usage requires current catalog support',
            ErrorCode.FunctionClosed,
        )
        result.set(row.build_id, { row, availability })
    }
    return result
}
function instances(tables, rows) {
    valid(Array.isArray(rows), 'Home-building instance storage is malformed')
    for (const row of rows) {
        valid(object(row), 'Home-building instance identity is malformed')
        ensure(
            homeBuildingAvailability(tables, row.build_id).available,
            'Retired furniture instances require current catalog support',
            ErrorCode.FunctionClosed,
        )
    }
}
function shortcuts(tables, bars) {
    valid(Array.isArray(bars), 'Home-building shortcut presentation is malformed')
    return bars.map((bar) => {
        valid(object(bar), 'Home-building shortcut bar is malformed')
        if (bar.type !== 1) return bar
        valid(
            Array.isArray(bar.item_id) && bar.item_id.every(slotId),
            'Home-building shortcut identities are malformed',
        )
        let changed = false
        const item_id = bar.item_id.map((id) => {
            if (id <= 0 || homeBuildingAvailability(tables, id).available) return id
            changed = true
            return 0
        })
        return changed ? { ...bar, item_id } : bar
    })
}

// LOCAL migration writeback, after the ordinary handler has validated the
// incoming current IDs. A wire0 cannot distinguish a hidden retired shortcut
// from an intentional clear of an already empty cell. Retain only the proven
// retired same-slot raw identity; an explicit current positive replacement is
// honored and the original is archived once. Ordinary clears stay ordinary.
export function mergeHomeBuildingShortcutWriteback(tables, state, bar) {
    valid(object(bar), 'Home-building shortcut writeback is malformed')
    if (bar.type !== 1) return bar
    valid(
        object(state.home) &&
            Array.isArray(state.home.shortcuts) &&
            Array.isArray(bar.item_id) &&
            bar.item_id.length <= 64 &&
            bar.item_id.every(slotId),
        'Home-building shortcut writeback identities are malformed',
    )
    for (const id of bar.item_id)
        if (id > 0)
            ensure(
                homeBuildingAvailability(tables, id).available,
                'Unavailable building cannot be added to a current shortcut',
                ErrorCode.BuildConfNotFound,
            )
    const previous = state.home.shortcuts.filter((row) => row.type === 1)
    valid(previous.length <= 1, 'Saved home-building shortcut bars are ambiguous')
    const old = previous[0]?.item_id ?? []
    valid(
        Array.isArray(old) && old.length <= 64 && old.every(slotId),
        'Saved home-building shortcut slots are malformed',
    )
    const retiredSlots = old.flatMap((id, slot) =>
        id > 0 && !homeBuildingAvailability(tables, id).available ? [{ type: 1, slot, build_id: id }] : [],
    )
    const ledger = state.homeBuildingCompatibility
    if (ledger !== undefined) {
        valid(
            object(ledger) &&
                ledger.version === 1 &&
                ledger.policyId === shortcutPolicyId &&
                Array.isArray(ledger.shortcutSlots) &&
                ledger.shortcutSlots.length <= 64,
            'Home-building shortcut archive is malformed',
        )
        const slots = new Set()
        for (const row of ledger.shortcutSlots) {
            valid(
                object(row) &&
                    row.type === 1 &&
                    Number.isInteger(row.slot) &&
                    row.slot >= 0 &&
                    row.slot < 64 &&
                    uint(row.build_id) &&
                    row.build_id > 0 &&
                    !slots.has(row.slot),
                'Home-building shortcut archive identity is malformed',
            )
            valid(
                !homeBuildingAvailability(tables, row.build_id).available,
                'Home-building shortcut archive is not a retired identity',
            )
            slots.add(row.slot)
        }
    }
    if (!retiredSlots.length) return bar
    const archive = [...(ledger?.shortcutSlots ?? [])]
    for (const row of retiredSlots) {
        const existing = archive.find((entry) => entry.type === row.type && entry.slot === row.slot)
        valid(
            !existing || existing.build_id === row.build_id,
            'Original retired home-building shortcut identity changed',
        )
        if (!existing) archive.push(row)
    }
    if (!ledger || archive.length !== ledger.shortcutSlots.length)
        state.homeBuildingCompatibility = { version: 1, policyId: shortcutPolicyId, shortcutSlots: archive }
    const item_id = [...bar.item_id]
    // Shorter client lists likewise contain no positive replacement for the
    // old tail. Preserve original positions rather than compacting them.
    while (item_id.length < old.length) item_id.push(0)
    for (const row of retiredSlots) if (item_id[row.slot] <= 0) item_id[row.slot] = row.build_id
    return item_id.length === bar.item_id.length && item_id.every((id, index) => id === bar.item_id[index])
        ? bar
        : { ...bar, item_id }
}

// LOCAL wire-only compatibility for proven retired inventory. Keep all raw
// assets/shortcut positions. Old furniture remains unusable in this catalog.
// TODO: no proven replacement definitions or arbitrary warm-cache reset.
// A cold client is required; omitted inventory cannot remove old cached rows.
export function homeBuildingPresentation(tables, state, payload) {
    if (payload == null) return payload
    valid(object(payload) && object(state.home), 'Home-building presentation context is malformed')
    const owned = inventory(tables, state.home.inventory)
    instances(tables, state.home.builds ?? [])
    instances(tables, state.home.storedBuilds ?? [])
    shortcuts(tables, state.home.shortcuts ?? [])
    let result = payload
    if (payload.builds !== undefined) {
        const rows = inventory(tables, payload.builds)
        const builds = payload.builds.filter((row) => {
            if (rows.get(row.build_id).availability.available) return true
            const original = owned.get(row.build_id)?.row
            valid(
                original && ['total_num', 'used_num', 'unlock'].every((key) => original[key] === row[key]),
                'Retired home-building wire ownership does not match saved assets',
            )
            return false
        })
        if (builds.length !== payload.builds.length) result = { ...result, builds }
    }
    if (payload.shortcut_bars !== undefined) {
        const bars = shortcuts(tables, payload.shortcut_bars)
        if (bars.some((bar, index) => bar !== payload.shortcut_bars[index])) result = { ...result, shortcut_bars: bars }
    }
    return result
}
