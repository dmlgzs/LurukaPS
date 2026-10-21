import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { planPetEvolution } from '../pet-evolution.js'
import { spend, spendCurrency } from '../inventory.js'
import { recordPetAcquisition } from '../pet-catalog.js'
import { mountPayload } from '../mounts.js'

export function registerPetEvolution(on) {
    on('RankUpPet', (c, r) => {
        const pet = c.state.pets.find((pet) => pet.guid === String(r.u64))
        ensure(pet, 'Pet is not owned', ErrorCode.PetNotExist)
        const plan = planPetEvolution(c.tables, c.state, pet, c.randomInt),
            bag = new Map()
        for (const cost of plan.costs) {
            if (cost.itemtype === 3) {
                const count = (bag.get(cost.itemid) ?? 0) + cost.itemnum
                ensure(
                    Number.isSafeInteger(count) && count <= 0xffffffff,
                    'Pet evolution cost overflow',
                    ErrorCode.GameConfig,
                )
                bag.set(cost.itemid, count)
            } else spendCurrency(c.state, cost.itemid, cost.itemnum)
        }
        spend(c.state, bag, plan.gold, c.now)
        // Preserve trained but no-longer-active labor/talent profiles as server
        // history. Never recreate the owned instance or reroll its aptitudes/DNA.
        c.state.petEvolutionProfiles ??= {}
        const profiles = (c.state.petEvolutionProfiles[pet.guid] ??= {})
        profiles[plan.from] = {
            inherent_skills: structuredClone(pet.inherent_skills ?? []),
            labor_infos: structuredClone(pet.labor_infos ?? []),
            talent_id: [...(pet.talent_id ?? [])],
        }
        Object.assign(pet, plan.update)
        c.state.petEvolutionHistory ??= {}
        const history = (c.state.petEvolutionHistory[pet.guid] ??= [])
        history.push({ from: plan.from, to: plan.to, time: c.now })
        recordPetAcquisition(c.tables, c.state, plan.to)
        c.state.petRevision = (c.state.petRevision ?? 0) + 1
        // Game publishes the changed pet and battle cache before the ACK. The
        // CBT3 pet sync recreates its formation entity on config_id changes.
        c.pushBefore('CSProtoRideMountInfo', mountPayload(c.tables, c.state))
        return {}
    })
}
