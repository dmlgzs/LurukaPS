import policy from '../configs/team-v2-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { preparedSystemAccess } from './system-access.js'
import { SystemUnlocks } from './system-unlocks.js'
import { sharedTeamTargetDefinition, requireSharedTeamTargetEligibility } from './team-v2-run-target.js'
const menus = new Map([
    [101, 1734],
    [500, 1735],
    [1, 1733],
])
const readers = new WeakMap()
const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff
export function teamV2Target(tables, typ, target) {
    ensure(menus.has(typ), 'TeamV2 campaign family is not implemented', ErrorCode.FunctionClosed)
    ensure(target && positive(target.dungeon_system_id), 'Malformed TeamV2 target', ErrorCode.ReqParamsError)
    ensure(
        target.dungeon_end_time === undefined || String(target.dungeon_end_time) === '0',
        'Client cannot set a TeamV2 dungeon deadline',
        ErrorCode.ReqParamsError,
    )
    const room = { typ, target: { dungeon_system_id: target.dungeon_system_id } }
    sharedTeamTargetDefinition(tables, room)
    return room
}
function menuAccess(tables, state, id, { readOnlyLegacyProjection = false } = {}) {
    const current = preparedSystemAccess(tables, state, id)
    if (current !== undefined) return current
    ensure(readOnlyLegacyProjection, 'Current team menu authority is not prepared', ErrorCode.GameConfig)
    // Reuse the exact current login migration on a detached snapshot. Existing
    // permanent authority is never reevaluated, and the peer save stays untouched.
    let reader = readers.get(tables)
    if (!reader) {
        reader = new SystemUnlocks(tables)
        readers.set(tables, reader)
    }
    const snapshot = structuredClone(state)
    reader.prepare(snapshot)
    return preparedSystemAccess(tables, snapshot, id)
}
export function requireTeamV2Target(c, room, id, state, options) {
    const definition = sharedTeamTargetDefinition(c.tables, room),
        menu = menus.get(room.typ)
    ensure(menu, 'TeamV2 campaign family is not implemented', ErrorCode.FunctionClosed)
    ensure(menuAccess(c.tables, state, menu, options), 'TeamV2 dungeon system is locked', ErrorCode.SystemLock)
    requireSharedTeamTargetEligibility(c, room, id, state)
    return definition
}
export function teamV2TargetUnlocked(c, room, id, state) {
    try {
        requireTeamV2Target(c, room, id, state, { readOnlyLegacyProjection: true })
        return true
    } catch (error) {
        if ([ErrorCode.SystemLock, ErrorCode.EntrustUnlock].includes(error.code)) return false
        throw error
    }
}

export function teamV2QueryContexts(tables, queries) {
    ensure(Array.isArray(queries), 'Malformed TeamV2 eligibility query')
    ensure(
        Number.isSafeInteger(policy.query_context_limit) && policy.query_context_limit > 0,
        'TeamV2 query resource policy is malformed',
        ErrorCode.GameConfig,
    )
    ensure(queries.length <= policy.query_context_limit, 'Too many TeamV2 eligibility contexts')
    return queries.map((query) => {
        ensure(query && typeof query === 'object' && !Array.isArray(query), 'Malformed TeamV2 eligibility context')
        const room = teamV2Target(tables, query.campaign_type, { dungeon_system_id: query.dungeon_system_id })
        return { campaign_type: room.typ, dungeon_system_id: room.target.dungeon_system_id, room }
    })
}
export function projectTeamV2QueryContexts(c, profile, state, id, contexts) {
    if (!contexts.length) return profile
    return {
        ...profile,
        dungeon_unlock_list: contexts.map((query) => ({
            campaign_type: query.campaign_type,
            dungeon_system_id: query.dungeon_system_id,
            unlock: teamV2TargetUnlocked(c, query.room, id, state),
        })),
    }
}
