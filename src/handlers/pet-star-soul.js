import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { planPetSoulUpgrade } from '../pet-star-soul.js'
import { petInActiveNpcDuel } from '../npc-kibo-duel.js'
import { spend, spendCurrency } from '../inventory.js'
import { recordPetStarSoulProgress } from '../pet-star-soul-progress.js'
export function registerPetStarSoul(on) {
    on('KiboStarLinkSoulUpdate', (c, r) => {
        const pet = c.state.pets.find((p) => p.guid === String(r.u64))
        ensure(pet, 'Pet is not owned', ErrorCode.PetNotExist)
        ensure(!pet.trial && !pet.trail, 'Temporary pet cannot be trained', ErrorCode.InvalidArgument)
        ensure(!petInActiveNpcDuel(c.state, pet.guid), 'Pet is in the active duel roster', ErrorCode.PetInBattle)
        const plan = planPetSoulUpgrade(c.tables, c.state, pet),
            bag = new Map()
        for (const cost of plan.costs) {
            if (cost.type === 3) bag.set(cost.id, (bag.get(cost.id) ?? 0) + cost.num)
            else spendCurrency(c.state, cost.id, cost.num)
        }
        spend(c.state, bag, 0, c.now)
        pet.soul_link_level = plan.value
        pet.inherent_skills = plan.skills
        recordPetStarSoulProgress(c.tables, c.state, pet)
        c.state.petRevision = (c.state.petRevision ?? 0) + 1
        return {}
    })
}
