import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { temporaryPets, temporaryHeroes } from './trial-actors.js'
import { refreshAutoBuildShortcut } from './home.js'

export const instanceTaskTypes = new Set([5, 14, 15])
export function taskInstanceGuid(value) {
    const text = String(value ?? '0')
    ensure(
        /^\d+$/.test(text) && BigInt(text) > 0n && BigInt(text) <= 0xffffffffffffffffn,
        'Task submission needs an explicit instance identity',
        ErrorCode.TaskSubmitItemChoseError,
    )
    return String(BigInt(text))
}
const assigned = (value, guid) => String(value ?? '0') === guid
function protectedPet(tables, state, pet) {
    const guid = String(pet.guid)
    ensure(!pet.is_lock, 'Submitted pet is locked', ErrorCode.PetIsLock)
    ensure(
        !pet.can_not_release && !pet.trail && !pet.trial && !temporaryPets(state).some((p) => assigned(p.guid, guid)),
        'Temporary or protected pets cannot be submitted',
        ErrorCode.TaskSubmitItemChoseError,
    )
    const heroes = [...state.player.heros_info.heros, ...temporaryHeroes(state)]
    ensure(!pet.hero_id || String(pet.hero_id) === '0', 'Submitted pet is equipped', ErrorCode.PetInBattle)
    ensure(
        !heroes.some((hero) => assigned(hero.pet_id, guid) || assigned(hero.trial_pet, guid)) &&
            !state.player.group_mgrs.some((manager) =>
                manager.groups.some((group) => group.heros.some((slot) => assigned(slot.pet_id, guid))),
            ),
        'Submitted pet is in a formation',
        ErrorCode.PetInBattle,
    )
    ensure(
        !pet.roulette_pos &&
            !pet.capacity_id &&
            !assigned(state.world.mount, guid) &&
            !Object.values(state.roulettes ?? {}).some(
                (row) => row.type === 1 && row.guid?.some((id) => assigned(id, guid)),
            ),
        'Submitted pet is assigned',
        ErrorCode.TaskSubmitItemChoseError,
    )
    const home = state.home
    ensure(
        !pet.work_status &&
            !pet.work_build &&
            !pet.station_lock &&
            !(home?.stationPets ?? []).some((id) => assigned(id, guid)) &&
            !(home?.builds ?? []).some(
                (build) =>
                    assigned(build.station_pet_guid, guid) ||
                    ['plant_pet', 'water_pet', 'harvest_pet'].some((key) => assigned(build.auto_info?.[key], guid)) ||
                    build.pet_canteen?.pets?.some((id) => assigned(id, guid)),
            ) &&
            !Object.values(home?.ranches ?? {}).some(
                (ranch) =>
                    assigned(ranch.harvest_pet, guid) ||
                    ranch.product_pets.some((slot) => assigned(slot.pet_guid, guid)),
            ),
        'Submitted pet is stationed or working',
        ErrorCode.PetInWork,
    )
    ensure(tables.find('pet', pet.config_id), 'Submitted pet configuration missing', ErrorCode.PetConfNotExist)
}

// Builds a complete removal plan first; no release/smelt rewards or daily
// release counters are involved in a task delivery.
export function taskResourcePlan(c, items) {
    const { state, tables } = c,
        pets = new Set(),
        eggs = new Set(),
        ornaments = new Set(),
        buildings = new Map()
    for (const item of items) {
        const type = item.item_type
        if (instanceTaskTypes.has(type)) {
            ensure(item.item_count === 1, 'Task instance quantity must be one', ErrorCode.TaskSubmitItemChoseError)
            const guid = taskInstanceGuid(item.item_guid)
            const selected = type === 5 ? pets : type === 14 ? eggs : ornaments
            ensure(!selected.has(guid), 'Duplicate submitted instance', ErrorCode.TaskSubmitItemChoseError)
            selected.add(guid)
            if (type === 5) {
                const pet = state.pets.find((p) => assigned(p.guid, guid))
                ensure(pet, 'Submitted pet is not owned', ErrorCode.PetNotExist)
                ensure(
                    pet.config_id === item.item_id,
                    'Submitted pet config mismatch',
                    ErrorCode.TaskSubmitItemChoseError,
                )
                protectedPet(tables, state, pet)
            } else if (type === 14) {
                const egg = (state.petEggs ?? []).find((e) => assigned(e.guid, guid))
                ensure(egg, 'Submitted egg is not owned', ErrorCode.EggNotExist)
                ensure(
                    tables.find('pet_egg', egg.configid),
                    'Submitted egg configuration missing',
                    ErrorCode.EggConfNotExist,
                )
                ensure(
                    egg.configid === item.item_id,
                    'Submitted egg config mismatch',
                    ErrorCode.TaskSubmitItemChoseError,
                )
                ensure(!egg.lock_state, 'Submitted egg is locked', ErrorCode.EggIsLock)
                ensure(
                    !egg.hatch_state &&
                        !egg.hatch_build_guid &&
                        !Object.values(state.home?.productionJobs ?? {}).some((jobs) =>
                            jobs.some((job) => assigned(job.eggGuid, guid)),
                        ) &&
                        !(state.home?.builds ?? []).some((build) =>
                            [...(build.hatch?.hatch_infos ?? []), ...(build.batch_hatch?.slots ?? [])].some((slot) =>
                                assigned(slot.egg_guid, guid),
                            ),
                        ),
                    'Submitted egg is incubating',
                    ErrorCode.EggInHatch,
                )
            } else {
                const ornament = (state.ornaments ?? []).find((o) => assigned(o.guid, guid))
                ensure(ornament, 'Submitted ornament is not owned', ErrorCode.OrnamentNotExist)
                ensure(
                    tables.find('accessory', ornament.id),
                    'Submitted ornament configuration missing',
                    ErrorCode.OrnamentConfFail,
                )
                ensure(
                    ornament.id === item.item_id,
                    'Submitted ornament config mismatch',
                    ErrorCode.TaskSubmitItemChoseError,
                )
                ensure(!ornament.lock, 'Submitted ornament is locked', ErrorCode.LockOrnament)
                ensure(
                    (!ornament.wear_hero || ornament.wear_hero === '0') &&
                        ![...state.player.heros_info.heros, ...temporaryHeroes(state)].some((hero) =>
                            hero.oguid?.some((id) => assigned(id, guid)),
                        ),
                    'Submitted ornament is equipped',
                    ErrorCode.EquipOrnament,
                )
                ensure(
                    !ornament.trial && !ornament.trail,
                    'Trial ornament cannot be submitted',
                    ErrorCode.TaskSubmitItemChoseError,
                )
            }
        } else if (type === 13) {
            ensure(
                !item.item_guid || item.item_guid === '0',
                'Building delivery requires unplaced stock',
                ErrorCode.TaskSubmitItemChoseError,
            )
            const row = state.home?.inventory.find((row) => row.build_id === item.item_id)
            ensure(row, 'Submitted building is not owned', ErrorCode.ItemNotEnough)
            ensure(
                tables.find('home_building', item.item_id),
                'Building configuration missing',
                ErrorCode.BuildConfNotFound,
            )
            const n = (buildings.get(item.item_id) ?? 0) + item.item_count
            // Stored instances may carry production or growth state. A count
            // request must not silently destroy an arbitrary saved instance.
            const stored = (state.home.storedBuilds ?? []).filter((build) => build.build_id === item.item_id).length
            ensure(
                Number.isSafeInteger(row.total_num) &&
                    Number.isSafeInteger(row.used_num) &&
                    row.total_num >= row.used_num + stored,
                'Invalid building stock state',
                ErrorCode.GameConfig,
            )
            ensure(
                row.total_num - row.used_num - stored >= n,
                'Insufficient unplaced uninstantiated buildings',
                ErrorCode.ItemNotEnough,
            )
            buildings.set(item.item_id, n)
        }
    }
    return () => {
        if (pets.size) {
            state.pets = state.pets.filter((pet) => !pets.has(String(pet.guid)))
            state.petRevision = (state.petRevision ?? 0) + 1
        }
        if (eggs.size) {
            state.petEggs = state.petEggs.filter((egg) => !eggs.has(String(egg.guid)))
            for (const guid of eggs) {
                if (state.eggOutcomes) delete state.eggOutcomes[guid]
                if (state.eggHatchConstraints) delete state.eggHatchConstraints[guid]
            }
            state.eggRevision = (state.eggRevision ?? 0) + 1
        }
        if (ornaments.size) {
            state.ornaments = state.ornaments.filter((item) => !ornaments.has(String(item.guid)))
            state.ornamentRevision = (state.ornamentRevision ?? 0) + 1
        }
        for (const [id, count] of buildings) {
            state.home.inventory.find((row) => row.build_id === id).total_num -= count
            refreshAutoBuildShortcut(state.home, id)
        }
        if (buildings.size) state.homeRevision = (state.homeRevision ?? 0) + 1
    }
}
