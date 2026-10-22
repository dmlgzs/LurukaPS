import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { planGeneFruit } from '../pet-gene-fruit.js'
import { petInActiveNpcDuel } from '../npc-kibo-duel.js'
import { petFavorPlan, applyPetFavorPlan } from '../pet-favor.js'
import { spend } from '../inventory.js'
export function registerGeneFruit(on) {
    on('UseGeneFruitReq', (c, r) => {
        const pet = c.state.pets.find((p) => p.guid === String(r.pet_id))
        ensure(pet, 'Pet is not owned', ErrorCode.PetNotExist)
        ensure(!pet.trial && !pet.trail, 'Temporary pet cannot be fed', ErrorCode.InvalidArgument)
        ensure(!petInActiveNpcDuel(c.state, pet.guid), 'Pet is in the active duel roster', ErrorCode.PetInBattle)
        const plan = planGeneFruit(c.tables, c.state, pet, r),
            favor = petFavorPlan(c.tables, c.state, pet, plan.favor, 162, c.now)
        spend(c.state, new Map([[r.item_id, 1]]), 0, c.now)
        pet.gene_infos = plan.genes
        pet.grade = plan.grade
        applyPetFavorPlan(c.state, pet, favor)
        c.state.petRevision = (c.state.petRevision ?? 0) + 1
        return {}
    })
}
