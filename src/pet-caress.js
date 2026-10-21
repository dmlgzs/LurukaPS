import { petFavorConstant, petFavorPlan, applyPetFavorPlan, refreshPetFavorPeriod } from './pet-favor.js'

export const refreshPetCaressPeriod = refreshPetFavorPeriod

export function caressPet(tables, state, pet, now) {
    const once = petFavorConstant(tables, 'FONDLE_PET_FAVORABILITY_ONCE')
    const limit = petFavorConstant(tables, 'PET_FAVORABILITY_FONDLE_MAX')
    const plan = petFavorPlan(tables, state, pet, once, 4, now, limit) // CBT3 FST_CARESS.
    applyPetFavorPlan(state, pet, plan)
    return {
        changed: plan.changed,
        response: { pet_guid: pet.guid, favor_exp_add: plan.gained, favor_lv_add: plan.levels },
    }
}
