import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const catalogs = new WeakMap()
const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0x7fffffff
const empty = () => Array.from({ length: 5 }, (_, i) => ({ slot_id: i + 1, background_id: 0 }))
function catalogue(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const rows = tables.get('esc_background')
    ensure(
        rows.length > 0 &&
            rows.every((r) => uint(r.id) && r.id > 0) &&
            new Set(rows.map((r) => r.id)).size === rows.length,
        'Invalid ESC background table',
        ErrorCode.GameConfig,
    )
    const data = rows.map((row) => ({
        ...row,
        terms: String(row.unlockCondi ?? '')
            .split('|')
            .filter(Boolean)
            .map((t) => t.split('#').map(Number)),
    }))
    catalogs.set(tables, data)
    return data
}
function ledger(state) {
    const data = state.escBackground
    ensure(
        data === undefined || (data && typeof data === 'object' && !Array.isArray(data)),
        'Invalid saved ESC background',
        ErrorCode.GameConfig,
    )
    ensure(
        data?.unlocked === undefined ||
            (Array.isArray(data.unlocked) &&
                data.unlocked.every((n) => uint(n) && n > 0) &&
                new Set(data.unlocked).size === data.unlocked.length),
        'Invalid saved ESC background unlock ledger',
        ErrorCode.GameConfig,
    )
    ensure(
        data?.tabs === undefined ||
            (data.tabs &&
                typeof data.tabs === 'object' &&
                !Array.isArray(data.tabs) &&
                Object.keys(data.tabs).every((key) => ['1', '2', '3'].includes(key))),
        'Invalid saved ESC background tabs',
        ErrorCode.GameConfig,
    )
    return data ?? { unlocked: [], tabs: {}, active_tab: 1 }
}
function sources(state) {
    const heroes = state.player.heros_info.heros.filter((h) => !h.trail && [0, 1].includes(h.type ?? 0))
    const skins = new Set(Object.values(state.unlockedHeroSkins ?? {}).flat())
    const souls = state.player.soulessence_infos.soulessences
    const tasks = new Set((state.taskRecords ?? []).filter((r) => r.count > 0).map((r) => r.task_id))
    return { heroes, skins, souls, tasks }
}
function eligible(row, source) {
    if (![1, 2, 4, 5].includes(row.resType) || row.timelimit !== 0 || !row.terms.length) return false
    return row.terms.every(([kind, id, amount, ...extra]) => {
        if (extra.length || !uint(id) || id === 0) return false
        if (kind === 2007) return amount === undefined && source.tasks.has(id)
        if (!uint(amount) || amount === 0) return false
        if (kind === 12023) return source.heroes.some((h) => h.conf_id === id && h.hero_lv >= amount)
        if (kind === 12284) return amount === 1 && source.skins.has(id)
        // A held instance proves GetSoulEssence. Historical consumption before
        // this ledger existed cannot be reconstructed and is not fabricated.
        if (kind === 12285) return source.souls.filter((s) => s.id === id).length >= amount
        return false
    })
}
export function prepareEscBackground(tables, state) {
    const old = ledger(state),
        source = sources(state)
    const unlocked = new Set(old.unlocked ?? [])
    for (const row of catalogue(tables)) if (eligible(row, source)) unlocked.add(row.id)
    const next = [...unlocked].sort((a, b) => a - b)
    if (state.escBackground && JSON.stringify(next) === JSON.stringify(old.unlocked)) return false
    state.escBackground = { ...old, unlocked: next }
    return true
}
function selected(state, tab) {
    const data = ledger(state),
        value = data.tabs?.[tab] ?? { tab_type: tab, play_type: 1, slots: empty() }
    ensure(
        value &&
            value.tab_type === tab &&
            [1, 2].includes(value.play_type) &&
            Array.isArray(value.slots) &&
            value.slots.length === 5 &&
            value.slots.every(
                (r) => r && Number.isInteger(r.slot_id) && r.slot_id >= 1 && r.slot_id <= 5 && uint(r.background_id),
            ) &&
            new Set(value.slots.map((r) => r.slot_id)).size === 5,
        'Invalid saved ESC background slots',
        ErrorCode.GameConfig,
    )
    return {
        tab_type: value.tab_type,
        play_type: value.play_type,
        slots: value.slots
            .map((r) => ({ slot_id: r.slot_id, background_id: r.background_id }))
            .sort((a, b) => a.slot_id - b.slot_id),
    }
}
export function escBackgroundUnlockSnapshot(tables, state) {
    const actual = new Set(catalogue(tables).map((r) => r.id))
    return { unlock_bgs: (ledger(state).unlocked ?? []).filter((id) => actual.has(id)) }
}
export function escBackgroundSnapshots(tables, state) {
    const data = ledger(state),
        active = data.active_tab ?? 1
    ensure([1, 2, 3].includes(active), 'Invalid active ESC background tab', ErrorCode.GameConfig)
    // Native19002 changes CurrentTab each time; restore the selected tab last.
    return [...[1, 2, 3].filter((t) => t !== active), active].map((tab) => selected(state, tab))
}
export function notifyEscBackground(c) {
    if (prepareEscBackground(c.tables, c.state))
        c.push('SCProtoEscBackgroundUnlockBgs', escBackgroundUnlockSnapshot(c.tables, c.state))
}
export function saveEscBackground(c, r) {
    ensure(
        [1, 2, 3].includes(r.tab_type) && [1, 2].includes(r.play_type),
        'Invalid ESC background tab/play mode',
        ErrorCode.InvalidArgument,
    )
    const slots = r.slots ?? []
    ensure(Array.isArray(slots) && slots.length <= 5, 'Invalid ESC background slot count', ErrorCode.InvalidArgument)
    prepareEscBackground(c.tables, c.state)
    const data = ledger(c.state),
        owned = new Set(data.unlocked),
        seen = new Set()
    for (const slot of slots) {
        ensure(
            slot &&
                Number.isInteger(slot.slot_id) &&
                slot.slot_id >= 1 &&
                slot.slot_id <= 5 &&
                !seen.has(slot.slot_id) &&
                uint(slot.background_id ?? 0),
            'Invalid/duplicate ESC background slot',
            ErrorCode.InvalidArgument,
        )
        seen.add(slot.slot_id)
        const id = slot.background_id ?? 0
        if (!id) continue
        const row = catalogue(c.tables).find((row) => row.id === id)
        ensure(row, 'Unknown ESC background ID', ErrorCode.InvalidArgument)
        ensure(
            (r.tab_type === 2 && [1, 2].includes(row.resType)) || (r.tab_type === 3 && [4, 5].includes(row.resType)),
            'ESC background does not belong to selected tab',
            ErrorCode.InvalidArgument,
        )
        ensure(owned.has(id), 'ESC background unlock condition not met', ErrorCode.InvalidArgument)
        ensure(row.timelimit === 0, 'Timed ESC background is not implemented', ErrorCode.FunctionClosed)
    }
    const next = {
        tab_type: r.tab_type,
        play_type: r.play_type,
        slots: empty().map((base) => ({
            ...base,
            background_id: slots.find((row) => row.slot_id === base.slot_id)?.background_id ?? 0,
        })),
    }
    c.state.escBackground = { ...data, tabs: { ...data.tabs, [r.tab_type]: next }, active_tab: r.tab_type }
    c.pushBefore('SCProtoEscBackgroundUnlockBgs', escBackgroundUnlockSnapshot(c.tables, c.state))
    c.pushBefore('SCProtoEscBackgroundInfo', next)
    // Native19001 callback only checks the error code; CSUin32 payload is unused.
    return { u32: 0 }
}
export function registerEscBackground(on) {
    on('SaveEscBackgroundInfo', saveEscBackground)
}
