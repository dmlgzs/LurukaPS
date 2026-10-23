import { ErrorCode } from '../error-codes.js'
import { ensureHome } from '../home.js'
import { reconcileFormationPets } from '../formation-pets.js'
import { repairMountSelection, mountPayload } from '../mounts.js'
import { clearFarmPetSlots } from './farm-workers.js'
import { ensure, pet } from './common.js'
import { clearRanchPetSlots, ranchWorkerLimit } from '../ranch.js'
import { collectionStation, stopCollection } from '../home-collection.js'

export function clearProductionPetSlots(state, guid, now) {
    for (const build of state.home?.builds ?? [])
        if (build.station_pet_guid === guid) {
            build.station_pet_guid = '0'
            stopCollection(build, state, now)
        }
}

export function registerProductionWorkers(on, tables) {
    on('PetStationed', (c, r) => {
        const home = ensureHome(tables, c.state)
        ensure(
            c.state.world.map_id === Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value),
            'Production dispatch requires the home scene',
        )
        // Despite its name, build_type carries PSWST_HOME_REST/HOME_WORK here.
        ensure(
            [1, 2].includes(r.build_type) && !r.sub_work_type,
            'Unsupported production dispatch operation',
            ErrorCode.InvalidProtoID,
        )
        const build = home.builds.find((entry) => entry.guid === r.build_guid)
        const collection = collectionStation(tables, build)
        const station = collection ?? (build && tables.find('home_building_production', build.build_id))
        ensure(
            build?.locate && [1, 4].includes(build.status) && station && [2, 8, 10, 12, 24].includes(build.build_type),
            'Production building is not owned or ready',
            collection ? ErrorCode.CollectBuildNotExist : ErrorCode.BuildProductConfNotFound,
        )
        ensure(
            !collection || r.build_type === 1,
            'Home collection requires HOME_REST dispatch',
            ErrorCode.InvalidProtoID,
        )
        const id = String(r.pet_guid ?? '0')
        const current = String(build.station_pet_guid ?? '0')
        const chosen = id === '0' || id === current ? null : pet(c.state, id)
        if (chosen) {
            const labor = String(station.laborType).split('|').map(Number)
            ensure(
                chosen.labor_infos?.some((entry) => labor.includes(entry.labor_id) && entry.labor_grade > 0),
                'Pet lacks required production ability',
                ErrorCode.PetLaborNotMatch,
            )
            let size =
                build.build_type === 12
                    ? tables.find('pet_home_talent', chosen.config_id)?.sizeType
                    : tables.find('pet', chosen.config_id)?.bodyType
            if (build.build_type === 8) {
                // The current accessory station opens PageStation, whose filter
                // reads pet_home_talent.sizeType, not the combat model bodyType.
                const talent = tables.find('pet_home_talent', chosen.config_id)
                ensure(talent, 'Pet home configuration is missing', ErrorCode.PetHomeConfNotExist)
                size = talent.sizeType
                ensure(
                    Number.isSafeInteger(size) && tables.get('pet_home_size').some((row) => row.sizeType === size),
                    'Pet home size configuration is malformed',
                    ErrorCode.GameConfig,
                )
            }
            ensure(
                String(station.petSize).split('|').map(Number).includes(size),
                'Pet size is not supported by this station',
                ErrorCode.InvalidArgument,
            )
            ensure(!chosen.work_status || [1, 2, 5, 6, 7].includes(chosen.work_status), 'Pet is working elsewhere')
            ensure(!r.source_build || chosen.work_build === r.source_build, 'Pet source building does not match')
            const stationed = home.stationPets ?? []
            if (!stationed.includes(chosen.guid)) {
                const limit = ranchWorkerLimit(tables, c.state, 'worker_max')
                const freed = r.out_hub && current !== '0' && stationed.includes(current) ? 1 : 0
                ensure(stationed.length - freed < limit, 'Home-hub pet slots are full', ErrorCode.HomeHubFull)
            }
        }
        if (current !== '0') {
            stopCollection(build, c.state, c.now)
            const old = pet(c.state, current)
            old.work_status = r.out_hub ? 0 : 7
            old.work_build = 0
            old.capacity_id = 0
            if (r.out_hub) home.stationPets = (home.stationPets ?? []).filter((guid) => guid !== old.guid)
        }
        build.station_pet_guid = chosen?.guid ?? '0'
        if (chosen) {
            clearProductionPetSlots(c.state, chosen.guid, c.now)
            clearRanchPetSlots(c.state, chosen.guid)
            clearFarmPetSlots(c.state, chosen.guid)
            build.station_pet_guid = chosen.guid
            const stationed = (home.stationPets ??= [])
            if (!stationed.includes(chosen.guid)) stationed.push(chosen.guid)
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
                c.state.world.mount_status = 0
                c.state.world.status = 0
                c.state.world.status_arg = '0'
            }
            chosen.roulette_pos = 0
            chosen.work_status = build.status === 4 ? 2 : 1
            chosen.work_build = build.guid
            chosen.capacity_id = collection ? station.petCapacity : station.petHomeAttribute
            if (repairMountSelection(tables, c.state))
                c.pushBefore('CSProtoRideMountInfo', mountPayload(tables, c.state))
        }
        c.state.petRevision = (c.state.petRevision || 0) + 1
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })
}
