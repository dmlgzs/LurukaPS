import { farmWorkSlots } from './farm-work-context.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const warned = new Set()
function diagnose(pet, reason) {
    const key = `${pet.guid}:${pet.config_id}:${reason}`
    if (warned.has(key)) return
    warned.add(key)
    while (warned.size > 256) warned.delete(warned.values().next().value)
    console.warn(
        '[pet-model-home]',
        JSON.stringify({
            event: 'unsafe-home-binding-not-cancelled',
            guid: pet.guid,
            config: pet.config_id,
            work_status: pet.work_status,
            reason,
        }),
    )
}
function hasJobReference(home, guid) {
    if (
        (home.builds ?? []).some(
            (build) =>
                String(build.station_pet_guid ?? '0') === guid ||
                [...farmWorkSlots.values()].some((key) => String(build.auto_info?.[key] ?? '0') === guid),
        )
    )
        return true
    return Object.values(home.ranches ?? {}).some(
        (ranch) =>
            String(ranch.harvest_pet ?? '0') === guid ||
            (ranch.product_pets ?? []).some((slot) => String(slot.pet_guid ?? '0') === guid),
    )
}

// Explicit writable login repair only. The caller owns the single petRevision
// increment shared with ordinary hero/formation repair. Never call ensureHome.
export function repairIdleHomePetModelBindings(tables, state, isEligible) {
    const home = state.home
    if (!home) return false
    ensure(typeof isEligible === 'function', 'Missing home pet model predicate', ErrorCode.GameConfig)
    const unavailable = state.pets.filter((pet) => !isEligible(tables, pet.config_id)),
        station = Array.isArray(home.stationPets) ? home.stationPets : [],
        removed = new Set()
    let changed = false
    for (const pet of unavailable) {
        const guid = String(pet.guid),
            stationed = station.some((id) => String(id) === guid)
        if (!stationed && !pet.work_status) continue
        if (![0, 7].includes(pet.work_status ?? 0) || hasJobReference(home, guid)) {
            diagnose(pet, 'active-or-unproven-job-reference')
            continue
        }
        if (stationed) removed.add(guid)
        if (pet.work_status === 7) {
            pet.work_status = 0
            pet.work_build = 0
            pet.capacity_id = 0
            changed = true
        }
    }
    if (removed.size) {
        home.stationPets = station.filter((id) => !removed.has(String(id)))
        state.homeRevision = (state.homeRevision ?? 0) + 1
        changed = true
    }
    return changed
}
