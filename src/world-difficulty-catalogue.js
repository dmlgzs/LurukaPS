import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const catalogues = new WeakMap()
export function worldDifficultyCatalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const rows = tables.get('world_difficulty_city'),
        maps = new Map(),
        byId = new Map()
    for (const row of rows) {
        ensure(
            Number.isSafeInteger(row.id) &&
                row.id > 0 &&
                !byId.has(row.id) &&
                Number.isSafeInteger(row.mapid) &&
                row.mapid > 0 &&
                tables.find('world_city', row.mapid) &&
                Number.isSafeInteger(row.difficultLv) &&
                row.difficultLv > 0 &&
                typeof row.condition === 'string',
            'Malformed map difficulty configuration',
            ErrorCode.GameConfig,
        )
        const levels = maps.get(row.mapid) ?? new Map()
        ensure(!levels.has(row.difficultLv), 'Duplicate map difficulty level', ErrorCode.GameConfig)
        levels.set(row.difficultLv, row)
        maps.set(row.mapid, levels)
        byId.set(row.id, row)
    }
    ensure(maps.size > 0, 'Missing map difficulty configuration', ErrorCode.GameConfig)
    const model = { rows, maps, byId }
    catalogues.set(tables, model)
    return model
}

// Pure lookup: enemy damage and movement must never initialize/persist a ledger.
export function selectedWorldDifficulty(tables, state, mapId = state.world.map_id) {
    const levels = worldDifficultyCatalogue(tables).maps.get(mapId)
    if (!levels) return state.world.map_id === mapId ? (state.world.difficulty ?? 1) : 1
    const saved = state.worldDifficulties?.[mapId]
    if (saved) {
        ensure(
            Number.isSafeInteger(saved.difficulty) && levels.has(saved.difficulty),
            'Invalid saved map difficulty',
            ErrorCode.GameConfig,
        )
        return saved.difficulty
    }
    const legacy = state.world.map_id === mapId ? state.world.difficulty : undefined
    return levels.has(legacy) ? legacy : Math.min(...levels.keys())
}
