import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const catalogs = new WeakMap()
function guideCatalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const groups = new Set(),
        steps = new Map()
    for (const row of tables.get('guide_group')) {
        ensure(
            uint(row.id) && row.id > 0 && !groups.has(row.id),
            'Malformed guide group directory',
            ErrorCode.GuideGroupConfFail,
        )
        groups.add(row.id)
        steps.set(row.id, new Set([0]))
    }
    for (const row of tables.get('guide')) {
        ensure(
            uint(row.id) && row.id > 0 && uint(row.groupId) && row.groupId > 0,
            'Malformed guide step directory',
            ErrorCode.GuideConfFail,
        )
        // The current step directory retains orphan historical groups. They
        // cannot start without guide_group, but do not invalidate live groups.
        if (groups.has(row.groupId)) {
            ensure(!steps.get(row.groupId).has(row.id), 'Duplicate guide step identity', ErrorCode.GuideConfFail)
            steps.get(row.groupId).add(row.id)
        }
    }
    const result = { groups, steps }
    catalogs.set(tables, result)
    return result
}
function savedSteps(state) {
    const infos = state.player.guide_infos?.infos ?? []
    ensure(Array.isArray(infos) && infos.length <= 4096, 'Malformed saved guide history', ErrorCode.GameConfig)
    for (const row of infos)
        ensure(
            row &&
                typeof row === 'object' &&
                uint(row.id) &&
                row.id > 0 &&
                uint(row.sub_id ?? 0) &&
                (row.complete === undefined || typeof row.complete === 'boolean'),
            'Malformed saved guide step',
            ErrorCode.GameConfig,
        )
    return infos
}

// Lua rsp_syncGuideData records every (id,subId); only subId0 completes a
// group. GuideBase.complete is not consulted by that normal-login consumer.
export function guideGroupComplete(state, id) {
    return savedSteps(state).some((row) => row.id === id && (row.sub_id ?? 0) === 0)
}

export function recordGuideStep(tables, state, request) {
    const id = request.id ?? 0,
        step = request.sub_id ?? 0,
        catalog = guideCatalog(tables)
    ensure(uint(id) && id > 0, 'Invalid guide group identity', ErrorCode.GuideGroupConfFail)
    ensure(catalog.groups.has(id), 'Guide group configuration is missing', ErrorCode.GuideGroupConfFail)
    ensure(
        uint(step) && catalog.steps.get(id).has(step),
        'Guide step is outside its current group',
        ErrorCode.GuideConfFail,
    )
    const infos = savedSteps(state),
        fact = { id, sub_id: step, complete: true }
    // Preserve all prior groups/steps, including historical IDs no longer in
    // current tables. An out-of-order positive step cannot erase group0.
    const matching = infos.some((row) => row.id === id && (row.sub_id ?? 0) === step)
    ensure(matching || infos.length < 4096, 'Guide history capacity is exhausted', ErrorCode.GameConfig)
    state.player.guide_infos ??= { infos: [] }
    state.player.guide_infos.infos = matching
        ? infos.map((row) => (row.id === id && (row.sub_id ?? 0) === step ? { ...row, ...fact } : row))
        : [...infos, fact]
    return fact
}

export function setGuideSkipChoice(state, raw, now) {
    const value = raw ?? 0 // Current CSUInt32 getter defaults to0, including an omitted false/zero.
    ensure(value === 0 || value === 1, 'Invalid skip-guide choice', ErrorCode.GuideSkipParamError)
    ensure(Number.isSafeInteger(now) && now >= 0, 'Invalid guide preference timestamp', ErrorCode.GameConfig)
    state.player.basic_info.skip_guide = value
    state.guideSkipChoice = { version: 1, source: 'explicit-5006', value, time: now }
    return value
}
