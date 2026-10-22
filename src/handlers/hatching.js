import { hatchReceipt } from '../hatch-effects.js'
import { ErrorCode } from '../error-codes.js'
import { hatchBuilding, startHatch, claimHatch, cancelHatch } from '../hatching.js'
import { refreshProduction, rescheduleJobs } from '../production.js'
import { ensure } from './common.js'
export function registerHatching(on) {
    on('HatchPetEgg', (c, r) => {
        startHatch(c, r.build_guid, r.egg_guid)
        refreshProduction(c.state, c.now)
        return {}
    })
    for (const cancel of [false, true])
        on(cancel ? 'CancelHatchPetEgg' : 'HatOutPetEgg', (c, r) => {
            hatchBuilding(c.state, r.build_guid)
            const jobs = c.state.home.productionJobs?.[r.build_guid] || [],
                job = jobs.find((j) => j.kind === 'hatch' && j.eggGuid === r.egg_guid)
            if (!job && !cancel) {
                const receipt = hatchReceipt(c.state, r.build_guid, r.egg_guid)
                if (receipt) {
                    ensure(
                        c.state.pets.some((pet) => pet.guid === receipt.petGuid),
                        'Previously hatched pet is no longer owned',
                        ErrorCode.PetNotExist,
                    )
                    return { pet_guid: receipt.petGuid, triggered_affix_ids: [...receipt.triggered] }
                }
            }
            ensure(job, 'Egg is not in this hatch queue', ErrorCode.PetEggNotInHatchQueue)
            let reward
            if (cancel) cancelHatch(c, job)
            else reward = claimHatch(c, job)
            c.state.home.productionJobs[r.build_guid] = jobs.filter((j) => j !== job)
            if (cancel) rescheduleJobs(c.state.home.productionJobs[r.build_guid], c.now)
            refreshProduction(c.state, c.now)
            c.state.homeRevision = (c.state.homeRevision || 0) + 1
            return cancel
                ? {}
                : {
                      pet_guid: reward.guid,
                      triggered_affix_ids: [...hatchReceipt(c.state, r.build_guid, r.egg_guid).triggered],
                  }
        })
}
