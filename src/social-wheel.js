import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'
const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff
const slot = (v) => Number.isInteger(v) && v >= 1 && v <= 8
const empty = () => Array.from({ length: 8 }, (_, i) => ({ index: i + 1, id: 0 }))
function catalogue(tables) {
    const rows = tables.get('social_wheel')
    ensure(
        rows.length > 0 &&
            rows.every((r) => uint(r.id) && r.id > 0) &&
            new Set(rows.map((r) => r.id)).size === rows.length,
        'Invalid social wheel table',
        ErrorCode.SocialEmotionsConfError,
    )
    return rows
}
function opened(tables, state) {
    const system = tables.find('system_unlock', 174)
    ensure(system, 'Missing social wheel system unlock', ErrorCode.GameConfig)
    return homeCondition(system.unlockCondi, state)
}
function available(tables, state) {
    if (!opened(tables, state)) return []
    // Local conservative policy: only enabled, unconditional lock_type=1 rows.
    // Future conditional/paid lock types require their actual entitlement source.
    return catalogue(tables).filter(
        (r) =>
            r.state === 1 &&
            r.lock_type === 1 &&
            !r.unlock &&
            ((r.type === 1 && typeof r.social_emotion === 'string' && r.social_emotion.length > 0) ||
                (r.type === 2 && typeof r.action === 'string' && r.action.length > 0)),
    )
}
function wheel(state) {
    const data = state.socialWheel
    ensure(
        data === undefined || (data && typeof data === 'object' && !Array.isArray(data)),
        'Invalid stored social wheel',
        ErrorCode.GameConfig,
    )
    const rows = data?.slots ?? empty()
    ensure(
        Array.isArray(rows) &&
            rows.length === 8 &&
            rows.every((r) => r && slot(r.index) && uint(r.id)) &&
            new Set(rows.map((r) => r.index)).size === 8,
        'Invalid stored social wheel slots',
        ErrorCode.GameConfig,
    )
    return rows
}
export function socialWheelSnapshot(tables, state) {
    const ids = new Set(available(tables, state).map((r) => r.id))
    return {
        infos: [...ids].sort((a, b) => a - b).map((id) => ({ id })),
        social_wheel: wheel(state)
            .map((r) => ({ index: r.index, id: ids.has(r.id) ? r.id : 0 }))
            .sort((a, b) => a.index - b.index),
        cur_emoticons_id: 0,
    }
}
export function prepareSocialWheel(tables, state) {
    const open = opened(tables, state)
    if (state.socialWheel?.open === open) return false
    const slots = wheel(state).map((r) => ({ ...r }))
    state.socialWheel = { ...state.socialWheel, slots, open }
    return true
}
export function notifySocialWheel(c) {
    if (prepareSocialWheel(c.tables, c.state))
        c.push('SCProtoSocialEmoticonsSyncInfo', socialWheelSnapshot(c.tables, c.state))
}
export function updateSocialWheel(c, r) {
    ensure(opened(c.tables, c.state), 'Social wheel system is locked', ErrorCode.FunctionClosed)
    const rows = r.wheel_data ?? []
    ensure(Array.isArray(rows) && rows.length <= 8, 'Invalid social wheel data size', ErrorCode.InvalidSocialWheelData)
    const seen = new Set(),
        ids = new Set(available(c.tables, c.state).map((r) => r.id))
    for (const row of rows) {
        ensure(row && slot(row.index), 'Invalid social wheel index', ErrorCode.InvalidSocialWheelIndex)
        ensure(
            uint(row.id ?? 0) && !seen.has(row.index),
            'Invalid/duplicate social wheel entry',
            ErrorCode.InvalidSocialWheelData,
        )
        seen.add(row.index)
        if (!r.del_all && row.id) {
            ensure(
                c.tables.find('social_wheel', row.id),
                'Unknown social wheel emote',
                ErrorCode.SocialEmotionsConfError,
            )
            ensure(ids.has(row.id), 'Social wheel emote is unavailable', ErrorCode.InvalidSocialWheelData)
        }
    }
    // The native unload-all sender sends the OLD full wheel and del_all=true.
    const next = r.del_all
        ? empty()
        : empty().map((base) => ({ ...base, id: rows.find((r) => r.index === base.index)?.id ?? 0 }))
    c.state.socialWheel = { ...c.state.socialWheel, slots: next, open: true }
    c.pushBefore('SCProtoSocialEmoticonsSyncInfo', socialWheelSnapshot(c.tables, c.state))
    return {}
}
export function selectSocialEmoticon(c, r) {
    ensure(opened(c.tables, c.state), 'Social wheel system is locked', ErrorCode.FunctionClosed)
    const id = r.u32 ?? 0
    ensure(
        uint(id) && id > 0 && c.tables.find('social_wheel', id),
        'Unknown social wheel emote',
        ErrorCode.SocialEmotionsConfError,
    )
    ensure(
        available(c.tables, c.state).some((row) => row.id === id),
        'Social wheel emote is unavailable',
        ErrorCode.InvalidSocialWheelData,
    )
    // This is a transient client state/animation event. Do not save a selection
    // or change combat, formation, actor, or mount state on the server.
    c.pushBefore('SCProtoSocialEmoticonsSyncInfo', { ...socialWheelSnapshot(c.tables, c.state), cur_emoticons_id: id })
    c.broadcast({ kind: 'map', map: c.state.world.map_id, sender: c.id }, 'SCProtoNotifyEmoticon', {
        player_id: c.id,
        emoticons_id: id,
    })
    return {}
}
export function registerSocialWheel(on) {
    on('UpdateEmoticonsWheel', updateSocialWheel)
    on('SelectEmoticons', selectSocialEmoticon)
}
