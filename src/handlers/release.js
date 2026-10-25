import { ensurePetNotInKiboTour } from '../kibo-tour-ledger.js'
import { ErrorCode } from '../error-codes.js'
import { petInActiveNpcDuel } from '../npc-kibo-duel.js'
import { ensure } from './common.js'
import { grantRewards } from '../rewards.js'
import { petReleaseRewards, releaseBonus } from '../pet-release.js'
import { releaseLedger } from '../release-ledger.js'
import { initializePetStarSoulProgress } from '../pet-star-soul-progress.js'
function unique(ids) {
    ensure(ids.length > 0 && new Set(ids.map(String)).size === ids.length, 'Invalid release selection')
}
export function registerRelease(on, tables) {
    const hour = Number(tables.get('game').find((r) => r.title === 'DAILY_REFRESH_TIME')?.value ?? 4)
    on('DelPet', (c, r) => {
        unique(r.pet_list)
        const pets = r.pet_list.map((id) => {
            const pet = c.state.pets.find((p) => p.guid === id)
            ensure(pet, 'Pet not owned')
            ensurePetNotInKiboTour(c.state, pet.guid)
            ensure(!petInActiveNpcDuel(c.state, pet.guid), 'Pet is in the active duel roster', ErrorCode.PetInBattle)
            const config = tables.find('pet', pet.config_id)
            ensure(config?.isRelease === 1 && !pet.can_not_release, 'Pet cannot be released')
            ensure(!pet.is_lock, 'Pet is locked')
            ensure(
                (!pet.hero_id || pet.hero_id === '0') &&
                    !c.state.player.heros_info.heros.some((h) => h.pet_id === pet.guid),
                'Pet is equipped',
            )
            ensure(!pet.roulette_pos && String(c.state.world.mount) !== pet.guid, 'Pet is assigned as a mount')
            ensure(
                !pet.work_status &&
                    !pet.work_build &&
                    !pet.station_lock &&
                    !c.state.home?.builds.some((b) => b.station_pet_guid === pet.guid),
                'Pet is stationed',
            )
            return pet
        })
        const ledger = releaseLedger(c.state, 'pet', c.now, hour),
            rewards = []
        let eligible = 0
        for (const pet of pets) {
            const result = petReleaseRewards(tables, pet)
            rewards.push(...result.rewards)
            if (result.bonusEligible) eligible++
        }
        rewards.push(...releaseBonus(tables, 'pet', ledger, eligible))
        // Migrate surviving trained instances before removal on a legacy
        // account's first request; already recorded attainments remain intact.
        initializePetStarSoulProgress(tables, c.state)
        const granted = grantRewards(tables, c.state, rewards)
        const ids = new Set(r.pet_list)
        c.state.pets = c.state.pets.filter((p) => !ids.has(p.guid))
        c.state.petRevision = (c.state.petRevision || 0) + 1
        ledger.lastTime = c.now
        c.state.releaseLedgers ??= {}
        c.state.releaseLedgers.pet = ledger
        c.push('CSProtoSyncPlayerData', c.state.player)
        return { rewards: granted }
    })
    on('DelEgg', (c, r) => {
        unique(r.egg_list)
        const eggs = r.egg_list.map((id) => {
            const egg = (c.state.petEggs || []).find((e) => e.guid === id)
            ensure(egg, 'Egg not owned')
            ensure(!egg.lock_state, 'Egg is locked')
            ensure(
                !egg.hatch_state &&
                    !egg.hatch_build_guid &&
                    !Object.values(c.state.home?.productionJobs || {}).some((jobs) =>
                        jobs.some((j) => j.eggGuid === id),
                    ),
                'Egg is incubating',
            )
            return egg
        })
        const ledger = releaseLedger(c.state, 'egg', c.now, hour),
            granted = grantRewards(tables, c.state, releaseBonus(tables, 'egg', ledger, eggs.length))
        const ids = new Set(r.egg_list)
        c.state.petEggs = c.state.petEggs.filter((e) => !ids.has(e.guid))
        for (const id of ids) {
            if (c.state.eggOutcomes) delete c.state.eggOutcomes[id]
            if (c.state.eggGenerationSeeds) delete c.state.eggGenerationSeeds[id]
            if (c.state.eggGenerationVersions) delete c.state.eggGenerationVersions[id]
            if (c.state.eggHatchConstraints) delete c.state.eggHatchConstraints[id]
        }
        c.state.eggRevision = (c.state.eggRevision || 0) + 1
        ledger.lastTime = c.now
        c.state.releaseLedgers ??= {}
        c.state.releaseLedgers.egg = ledger
        c.push('CSProtoSyncPlayerData', c.state.player)
        return { rewards: granted }
    })
}
