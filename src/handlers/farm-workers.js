import { ErrorCode } from '../error-codes.js'
import { registerFarmStorage } from '../farm-storage.js'
import { farmWorkSlots } from '../farm-work-context.js'
import { ensureHome, ensureHomeFarmHouses } from '../home.js'
import { reconcileFormationPets } from '../formation-pets.js'
import { repairMountSelection, mountPayload } from '../mounts.js'
import { ensure } from './common.js'
import { clearRanchPetSlots, ranchWorkerLimit } from '../ranch.js'

export { farmWorkSlots }

export function clearFarmPetSlots(state, guid) {
    let changed = false
    for (const build of state.home?.builds ?? [])
        for (const field of farmWorkSlots.values()) {
            if (build.auto_info?.[field] !== guid) continue
            build.auto_info[field] = '0'
            changed = true
        }
    return changed
}

export function registerFarmWorkers(on, tables) {
    registerFarmStorage(on, tables)
    const capacities = new Map(tables.get('home_labor_capacity').map((row) => [row.laborCapacityId, row]))
    on('ChoseAutoWorkPet', (c, r) => {
        ensure(
            c.state.world.map_id === Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value),
            'Farm dispatch requires the home scene',
            ErrorCode.PlayerNotInHome,
        )
        ensure((r.operate_type ?? 0) === 0, 'Unsupported farm dispatch operation', ErrorCode.InvalidProtoID)
        const home = ensureHome(tables, c.state),
            build = home.builds.find((item) => item.guid === r.build_guid)
        const config = build && tables.find('home_building', build.build_id)
        const group = config && tables.get('home_building_group').find((row) => row.groupId === config.groupId)
        ensure(build, 'Farm house is not owned', ErrorCode.HomeBuildGuidInvild)
        ensure(config, 'Farm house configuration is missing', ErrorCode.BuildConfNotFound)
        ensure(group, 'Farm house building group configuration is missing', ErrorCode.BuildGroupConfNotFound)
        ensure(group.type === 16, 'Building does not support farm dispatch', ErrorCode.BuildTypeNotMatch)
        ensure(build.locate && build.status === 1, 'Farm house is not owned/ready', ErrorCode.HomeBuildInvalidStatus)
        const field = farmWorkSlots.get(r.work_type),
            capacity = capacities.get(r.work_type)
        ensure(field, 'Unknown farm work slot', ErrorCode.InvalidArgument)
        ensure(capacity, 'Farm work slot configuration is missing', ErrorCode.GameConfig)
        ensureHomeFarmHouses(tables, c.state)
        const id = String(r.pet_guid ?? '0'),
            chosen = id === '0' ? null : c.state.pets.find((item) => item.guid === id)
        ensure(id === '0' || chosen, 'Farm worker pet is not owned', ErrorCode.PetNotExist)
        if (chosen) {
            ensure(
                chosen.labor_infos?.some((info) => info.labor_id === capacity.laborType && info.labor_grade > 0),
                'Pet lacks required farming ability',
                ErrorCode.PetLaborNotMatch,
            )
            ensure(
                !chosen.work_status || [5, 6, 7].includes(chosen.work_status),
                'Pet is working elsewhere',
                ErrorCode.PetIsWorking,
            )
            if (chosen.work_status === 5)
                ensure(
                    home.builds.some(
                        (item) =>
                            item.guid === chosen.work_build &&
                            [...farmWorkSlots.values()].some((slot) => item.auto_info?.[slot] === chosen.guid),
                    ),
                    'Field worker record is inconsistent',
                    ErrorCode.GameConfig,
                )
        }
        const oldId = build.auto_info[field] ?? '0'
        if (
            (!chosen && oldId === '0') ||
            (chosen &&
                oldId === chosen.guid &&
                chosen.work_status === 5 &&
                chosen.work_build === build.guid &&
                chosen.capacity_id === r.work_type)
        )
            return {}
        if (chosen) {
            clearFarmPetSlots(c.state, chosen.guid)
            clearRanchPetSlots(c.state, chosen.guid)
        }
        if (oldId !== '0' && oldId !== chosen?.guid) {
            const old = c.state.pets.find((item) => item.guid === oldId)
            ensure(old, 'Saved farm worker is missing', ErrorCode.GameConfig)
            clearFarmPetSlots(c.state, oldId)
            old.work_status = r.out_hub ? 0 : 7
            old.work_build = 0
            old.capacity_id = 0
            if (r.out_hub) home.stationPets = (home.stationPets ?? []).filter((guid) => guid !== oldId)
        }
        build.auto_info[field] = chosen?.guid ?? '0'
        if (chosen) {
            const station = (home.stationPets ??= [])
            if (!station.includes(chosen.guid)) {
                // HomeUtil.GetPetStationedWorkingLimit (06006302): home-level
                // worker_max plus every unlocked free-work increment.
                const limit = ranchWorkerLimit(tables, c.state, 'worker_max')
                ensure(station.length < limit, 'Home-hub pet slots are full', ErrorCode.HomeHubFull)
                station.push(chosen.guid)
            }
            const bound = c.state.player.heros_info.heros.filter((hero) => hero.pet_id === chosen.guid)
            for (const hero of bound) hero.pet_id = '0'
            if (bound.length || (chosen.hero_id && chosen.hero_id !== '0')) {
                chosen.hero_id = '0'
                reconcileFormationPets(c.state)
                c.pushBefore('CSProtoSyncPlayerData', {
                    heros_info: c.state.player.heros_info,
                    group_mgrs: c.state.player.group_mgrs,
                })
            }
            if (c.state.world.mount === chosen.guid) {
                c.state.world.mount = '0'
                c.state.world.status = 0
                c.state.world.mount_status = 0
                c.state.world.status_arg = '0'
            }
            chosen.roulette_pos = 0
            chosen.work_status = 5 // PSWST_FIELD_WORK, distinct from home-center idle (7).
            chosen.work_build = build.guid
            chosen.capacity_id = r.work_type
            if (repairMountSelection(tables, c.state))
                c.pushBefore('CSProtoRideMountInfo', mountPayload(tables, c.state))
        }
        c.state.petRevision = (c.state.petRevision || 0) + 1
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })
}
