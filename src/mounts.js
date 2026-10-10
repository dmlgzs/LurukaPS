import { randomInt } from 'node:crypto'
import { ensure } from './handlers/common.js'

export function randomMountSpeed(tables, rng = randomInt) {
    const rows = tables.get('mount_speed'),
        total = rows.reduce((sum, row) => sum + row.weight, 0)
    ensure(
        Number.isSafeInteger(total) &&
            total > 0 &&
            rows.every(
                (row) =>
                    Number.isInteger(row.weight) &&
                    row.weight > 0 &&
                    Number.isInteger(row.min) &&
                    Number.isInteger(row.max) &&
                    row.min > 0 &&
                    row.min <= row.max,
            ),
        'Invalid mount-speed distribution',
        1007,
    )
    let draw = rng(total)
    for (const row of rows) {
        draw -= row.weight
        if (draw < 0) return rng(row.min, row.max + 1)
    }
    throw Error('Mount-speed distribution selection failed')
}
export function mountCandidates(tables, state) {
    return state.pets
        .filter((p) => p.roulette_pos > 0 && tables.find('mount', p.config_id))
        .sort((a, b) => a.roulette_pos - b.roulette_pos || a.config_id - b.config_id)
}
export function repairMountSelection(tables, state) {
    const candidates = mountCandidates(tables, state)
    if (candidates.some((p) => p.guid === state.mountRideId)) return false
    // Prefer the first ordinary mount for a short press; gliders use move type 5.
    const next = candidates.find((p) => tables.find('mount', p.config_id)?.defaultMoveType !== 5) ?? candidates[0]
    const id = next?.guid ?? '0'
    if (state.mountRideId === id) return false
    state.mountRideId = id
    return true
}
export function mountPayload(tables, state) {
    return {
        ride_id: state.mountRideId ?? '0',
        mount_saddlerys: state.mountSaddles ?? tables.get('mount_saddle').map((row) => row.id),
    }
}

// Active riding is scene-local. The selected roulette mount remains available.
export function clearSceneMount(state) {
    const world = state.world
    const changed = world.status === 1 || (world.mount && world.mount !== '0') || !!world.mount_status
    if (world.status === 1) {
        world.status = 0
        world.status_arg = '0'
    }
    world.mount = '0'
    world.mount_status = 0
    delete world.pendingMountExit
    return !!changed
}
