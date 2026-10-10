import { ensure } from './handlers/common.js'
// CBT3 WorldExploreStore.GetLockFlyLevel selects systemUnlock=3.
// User-requested sandbox unlock: raise only to that minimum, never to max.
export function ensureFlightUnlocked(tables, state, now) {
    const rows = tables.get('explore_map_reward').filter((row) => row.systemUnlock === 3)
    const exploration = (state.exploration ??= { map_info: [], mission_info: [] })
    exploration.map_info ??= []
    let changed = false
    for (const row of rows) {
        ensure(
            Number.isInteger(row.mapId) &&
                row.mapId > 0 &&
                Number.isInteger(row.exploreLevel) &&
                row.exploreLevel > 0 &&
                tables.find('world_city', row.mapId),
            'Invalid flight exploration gate',
            1007,
        )
        let entry = exploration.map_info.find((m) => m.map_id === row.mapId)
        if (!entry) {
            entry = { map_id: row.mapId, lv: row.exploreLevel, exp: 0, time: now, rewards: [] }
            exploration.map_info.push(entry)
            changed = true
        } else if ((entry.lv ?? 0) < row.exploreLevel) {
            entry.lv = row.exploreLevel
            changed = true
        }
    }
    return changed
}
export function explorationSnapshot(state) {
    return { ...state.exploration, login: true }
}
