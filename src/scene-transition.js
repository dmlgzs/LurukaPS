import { clearSceneMount } from './mounts.js'
// Only server-authorized map changes can open this movement allowance.
// Readiness acknowledgments or a valid destination move close it; old reports
// are discarded, never applied to the destination or echoed to the client.
export function beginSceneTransition(state, previousMapId, now, command) {
    const world = state.world
    if (!Number.isInteger(previousMapId) || previousMapId <= 0 || previousMapId === world.map_id) return false
    // Never recreate the destination player from the previous scene's ride.
    clearSceneMount(state)
    world.scene_transition = { from_map_id: previousMapId, to_map_id: world.map_id, command, started_at: now }
    world.client_loaded = false
    delete world.loaded_at
    return true
}

export function isPreviousSceneMovement(state, mapId) {
    const transition = state.world.scene_transition
    return !!(
        transition &&
        !state.world.client_loaded &&
        transition.to_map_id === state.world.map_id &&
        transition.from_map_id === mapId
    )
}

export function endSceneTransition(state, command) {
    if (command !== undefined && state.world.scene_transition?.command !== command) return
    delete state.world.scene_transition
}
