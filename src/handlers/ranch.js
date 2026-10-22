import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { ensureHome } from '../home.js'
import { clearFarmPetSlots } from './farm-workers.js'
import { clearProductionPetSlots } from './production-workers.js'
import { reconcileFormationPets } from '../formation-pets.js'
import { repairMountSelection, mountPayload } from '../mounts.js'
import {
    ranchAt,
    ranchCatalog,
    ranchWorkerLimit,
    ranchPetDrops,
    ranchSeconds,
    clearRanchPetSlots,
    settleRanches,
} from '../ranch.js'
import { pickRanchDrops, storeRanchDrop } from '../ranch-claims.js'
import { grantRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'

export function ranchContext(c, block) {
    const map = ranchCatalog(c.tables).constants.get('HOME_ID')
    ensure(c.state.world.map_id === map, 'Ranch operation requires the home scene', ErrorCode.PlayerNotInHome)
    ensureHome(c.tables, c.state)
    return ranchAt(c.tables, c.state, block)
}
export function registerRanch(on, tables) {
    on('RanchGetStoreReward', (c, request) => {
        const ranch = ranchContext(c, request.u32)
        ensure(ranch.stores.length > 0, 'Ranch storage is empty', ErrorCode.HomeRanchStoreIsNull)
        const rewards = grantRewards(tables, c.state, ranch.stores)
        ranch.stores = []
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return { rewards, src: rewardSource(tables, 'ranchStoreHarvest') }
    })
    on('RanchPetAutoGetReward', (c, request) => {
        const ranch = ranchContext(c, request.block_id)
        storeRanchDrop(tables, c.state, ranch, request.reward_guid)
        return {}
    })
    on('RanchPlayerGetReward', (c, request) => {
        const ranch = ranchContext(c, request.block_id)
        pickRanchDrops(tables, c.state, ranch, request)
        // Current response is ProtoNullRsp; the shared dispatcher sends actual
        // inventory/egg/ranch deltas before this pickup acknowledgement.
        return {}
    })
    on('RanchSetPetOption', (c, request) => {
        const ranch = ranchContext(c, request.block_id),
            data = ranchCatalog(tables)
        ensure([1, 2].includes(request.work_type), 'Invalid ranch work role', ErrorCode.InvalidArgument)
        const producer = request.work_type === 1,
            slot = request.slot ?? 0
        ensure(
            Number.isSafeInteger(slot) &&
                (producer ? slot >= 1 && slot <= ranchWorkerLimit(tables, c.state) : slot === 0),
            'Ranch work slot is locked',
            ErrorCode.HomeRanchLvPosLimit,
        )
        const id = String(request.pet_guid ?? '0'),
            chosen = id === '0' ? null : c.state.pets.find((pet) => pet.guid === id)
        ensure(id === '0' || chosen, 'Ranch pet is not owned', ErrorCode.PetNotExist)
        const capacity = data.constants.get(
            producer ? 'HOME_PET_RANCH_PRODUCE_ATTRIBUTE' : 'HOME_PET_RANCH_HARVEST_ATTRIBUTE',
        )
        const existing = producer
            ? (ranch.product_pets.find((entry) => entry.slot === slot)?.pet_guid ?? '0')
            : ranch.harvest_pet
        if (chosen) {
            ensure(
                !chosen.work_status || [1, 2, 5, 6, 7].includes(chosen.work_status),
                'Pet is working elsewhere',
                ErrorCode.PetIsWorking,
            )
            ensure(
                tables.find('pet_home_talent', chosen.config_id),
                'Missing ranch pet talent configuration',
                ErrorCode.GameConfig,
            )
            if (producer)
                ensure(
                    ranchPetDrops(tables, chosen).length,
                    'Pet cannot produce ranch items',
                    ErrorCode.BuildPetAutoWorkInvalid,
                )
            else
                ensure(
                    chosen.labor_infos?.some(
                        (info) =>
                            info.labor_id === data.constants.get('HOME_PET_RANCH_HARVEST_LABORTYPE') &&
                            info.labor_grade > 0,
                    ),
                    'Pet lacks ranch harvesting ability',
                    ErrorCode.BuildPetAutoWorkInvalid,
                )
            const home = c.state.home,
                stationed = home.stationPets ?? []
            const freed =
                request.out_hub && existing !== '0' && existing !== chosen.guid && stationed.includes(existing) ? 1 : 0
            ensure(
                stationed.includes(chosen.guid) ||
                    stationed.length - freed < ranchWorkerLimit(tables, c.state, 'worker_max'),
                'Home hub worker capacity exceeded',
                ErrorCode.HomeRanchLvPosLimit,
            )
        }
        if (
            existing === id &&
            (!chosen ||
                (chosen.work_status === 6 && chosen.work_build === ranch.block_id && chosen.capacity_id === capacity))
        )
            return {}
        settleRanches(tables, c.state, c.now, c.randomInt)
        if (existing !== '0' && existing !== chosen?.guid) {
            const previous = c.state.pets.find((pet) => pet.guid === existing)
            ensure(previous, 'Missing previous ranch worker', ErrorCode.GameConfig)
            clearRanchPetSlots(c.state, existing)
            previous.work_status = request.out_hub ? 0 : 7
            previous.work_build = 0
            previous.capacity_id = 0
            if (request.out_hub)
                c.state.home.stationPets = (c.state.home.stationPets || []).filter((guid) => guid !== existing)
        }
        if (chosen) {
            clearFarmPetSlots(c.state, chosen.guid)
            clearProductionPetSlots(c.state, chosen.guid, c.now)
            clearRanchPetSlots(c.state, chosen.guid)
            const stationed = (c.state.home.stationPets ??= [])
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
            if (c.state.world.mount === chosen.guid)
                Object.assign(c.state.world, { mount: '0', mount_status: 0, status: 0, status_arg: '0' })
            chosen.roulette_pos = 0
            chosen.work_status = 6
            chosen.work_build = ranch.block_id
            chosen.capacity_id = capacity
            if (producer)
                ranch.product_pets.push({
                    slot,
                    pet_guid: chosen.guid,
                    drop_times: ranchPetDrops(tables, chosen).map((row) => {
                        const seconds = ranchSeconds(tables, c.state, chosen, row)
                        ensure(c.now + seconds <= 0xffffffff, 'Ranch production clock overflow', ErrorCode.InvalidLogic)
                        return { drop_id: row.id, time: c.now + seconds, seconds }
                    }),
                })
            else ranch.harvest_pet = chosen.guid
            if (repairMountSelection(tables, c.state))
                c.pushBefore('CSProtoRideMountInfo', mountPayload(tables, c.state))
        }
        c.state.petRevision = (c.state.petRevision || 0) + 1
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })
}
