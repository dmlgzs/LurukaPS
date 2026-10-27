import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { repairIdleHomePetModelBindings } from './pet-model-home.js'

const models = new WeakMap()
const positive = (value) => Number.isSafeInteger(value) && value > 0
function catalog(tables) {
    if (models.has(tables)) return models.get(tables)
    const pets = tables.get('pet'),
        units = tables.get('unit')
    // A broken catalog cannot be used as proof to clear every saved binding.
    ensure(
        Array.isArray(pets) &&
            pets.length > 0 &&
            Array.isArray(units) &&
            units.length > 0 &&
            pets.every((row) => row && positive(row.id)) &&
            units.every((row) => row && positive(row.id)) &&
            new Set(pets.map((row) => row.id)).size === pets.length &&
            new Set(units.map((row) => row.id)).size === units.length,
        'Pet model catalogs are missing or malformed',
        ErrorCode.GameConfig,
    )
    const unitById = new Map(units.map((row) => [row.id, row])),
        result = new Map()
    for (const pet of pets) {
        const unit = positive(pet.unitId) ? unitById.get(pet.unitId) : null,
            primary = Array.isArray(unit?.model)
                ? unit.model[0]
                : typeof unit?.model === 'string'
                  ? unit.model.split(',')[0]
                  : null,
            usable = typeof primary === 'string' && primary.trim().length > 0 && !primary.includes('\0')
        // TDUnitTable.GetModelPath0602111e resolves the configured primary
        // model. Do not invent a path from the pet ID or check local CDN files.
        result.set(pet.id, {
            eligible: !!unit && usable,
            unitId: pet.unitId,
            model: usable ? primary : null,
            reason: !unit ? 'missing-unit' : usable ? null : 'missing-primary-model',
        })
    }
    ensure(
        [...result.values()].some((row) => row.eligible),
        'Pet model catalog has no deployable definitions',
        ErrorCode.GameConfig,
    )
    models.set(tables, result)
    return result
}

export function petModelEligibility(tables, configId) {
    return catalog(tables).get(configId) ?? { eligible: false, model: null, reason: 'missing-pet' }
}

export function requirePetModel(tables, pet) {
    ensure(pet, 'Pet not owned', ErrorCode.PetNotExist)
    const status = petModelEligibility(tables, pet.config_id)
    ensure(
        status.eligible,
        `Pet model configuration is unavailable (${pet.config_id}/${status.reason})`,
        status.reason === 'missing-pet' ? ErrorCode.PetConfNotExist : ErrorCode.GameConfig,
    )
    return pet
}

export function requireNormalFormationPetModels(tables, state, group) {
    const heroes = new Map(state.player.heros_info.heros.map((hero) => [String(hero.guid), hero])),
        pets = new Map(state.pets.map((pet) => [String(pet.guid), pet]))
    for (const slot of group.heros ?? []) {
        const hero = heroes.get(String(slot.hero_id ?? '0'))
        for (const id of new Set([String(slot.pet_id ?? '0'), String(hero?.pet_id ?? '0')]))
            if (id !== '0') requirePetModel(tables, pets.get(id))
    }
}

// Only writable login/initialization transactions call this migration. Keep
// every owned pet and all unrelated fields; only unsafe normal bindings clear.
export function repairPetModelBindings(tables, state) {
    const unavailable = state.pets.filter((pet) => !petModelEligibility(tables, pet.config_id).eligible),
        ids = new Set(unavailable.map((pet) => String(pet.guid)))
    let changed = false
    for (const pet of unavailable)
        if (pet.hero_id && pet.hero_id !== '0') {
            pet.hero_id = '0'
            changed = true
        }
    for (const hero of state.player.heros_info.heros)
        if (ids.has(String(hero.pet_id ?? '0'))) {
            hero.pet_id = '0'
            changed = true
        }
    for (const manager of state.player.group_mgrs ?? []) {
        if (manager.type !== 1) continue
        for (const group of manager.groups ?? []) {
            if (group.id === 0) continue // Registered trial formation is independent.
            for (const slot of group.heros ?? [])
                if (ids.has(String(slot.pet_id ?? '0'))) {
                    slot.pet_id = '0'
                    changed = true
                }
        }
    }
    const homeChanged = repairIdleHomePetModelBindings(
        tables,
        state,
        (table, configId) => petModelEligibility(table, configId).eligible,
    )
    if (homeChanged) changed = true
    if (changed) {
        state.petRevision = (state.petRevision ?? 0) + 1
        console.warn(
            '[pet-model]',
            JSON.stringify({
                event: 'normal-bindings-repair-planned',
                configs: [...new Set(unavailable.map((pet) => pet.config_id))],
            }),
        )
    }
    return changed
}
