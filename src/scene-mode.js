import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const catalogues = new WeakMap()
const warned = new WeakMap()
// Current1.0 WorldHelper.ConvertWorldType2DefaultOnlineMode IL060092cf.
// Only use a client default where scene_mode has no matching sceneTypeId.
const clientDefaults = new Map([
    [4, 2],
    [13, 19],
    [100, 1],
])

export function sceneModePayload(tables, state, { multiplayer } = {}) {
    if (!catalogues.has(tables)) {
        const rows = tables.get('scene_mode')
        ensure(
            Array.isArray(rows) &&
                rows.length > 0 &&
                rows.every(
                    (row) =>
                        Number.isSafeInteger(row.id) &&
                        row.id > 0 &&
                        Number.isSafeInteger(row.sceneTypeId) &&
                        Number.isSafeInteger(row.dungeonTypeId) &&
                        [0, 1].includes(row.isMultiPlay),
                ),
            'Invalid scene mode configuration',
            ErrorCode.GameConfig,
        )
        ensure(
            new Set(rows.map((row) => row.id)).size === rows.length,
            'Duplicate scene mode identity',
            ErrorCode.GameConfig,
        )
        catalogues.set(tables, rows)
    }
    const rows = catalogues.get(tables),
        city = tables.find('world_city', state.world.map_id)
    ensure(city, 'Scene mode map configuration unavailable', ErrorCode.GameConfig)
    const active = [state.entrust?.run, state.storyCampaign, state.multiCampaign, state.cultTrial, state.abyssRun].find(
        (run) => run?.map_id === city.id,
    )
    const dungeon = active?.dungeon_id ? tables.find('dungeon', active.dungeon_id) : undefined
    // Preserve the existing multiple-dungeon authority. A one-person local
    // instance can still use the multiple-playing protocol/scene service.
    const multi = multiplayer ?? (city.type === 4 || (city.type === 12 && !!active && active === state.entrust?.run))
    let candidates = rows.filter((row) => row.sceneTypeId === city.type && row.isMultiPlay === Number(multi))
    const exact = dungeon && candidates.filter((row) => row.dungeonTypeId === dungeon.dungeonType)
    if (exact?.length) candidates = exact
    else {
        const ordinary = candidates.filter((row) => row.dungeonTypeId === 0)
        const generic = candidates.filter((row) => row.dungeonTypeId === 1)
        if (ordinary.length) candidates = ordinary
        else if (generic.length) candidates = generic
    }
    if (!candidates.length && clientDefaults.has(city.type)) {
        const fallback = rows.find((row) => row.id === clientDefaults.get(city.type))
        ensure(fallback, 'Current client scene default is missing from scene_mode', ErrorCode.GameConfig)
        candidates = [fallback]
    }
    if (!candidates.length) {
        // No invented mode for retired/subscene configurations. Keep a visible
        // migration gap until the current client establishes their inheritance.
        if (!warned.has(tables)) warned.set(tables, new Set())
        const key = `${city.type}:${dungeon?.dungeonType ?? 0}:${Number(multi)}`
        if (!warned.get(tables).has(key)) {
            warned.get(tables).add(key)
            console.warn(
                '[scene-mode]',
                JSON.stringify({
                    event: 'unresolved-scene-mode',
                    map: city.id,
                    sceneType: city.type,
                    dungeonType: dungeon?.dungeonType ?? 0,
                    multiplayer: !!multi,
                }),
            )
        }
        return null
    }
    ensure(candidates.length === 1, 'Ambiguous scene mode configuration', ErrorCode.GameConfig)
    return { mode: candidates[0].id }
}

export function pushSceneMode(c, options) {
    const payload = sceneModePayload(c.tables, c.state, options)
    if (payload) c.push('CSProtoSceneModeChange', payload)
    return !!payload
}
