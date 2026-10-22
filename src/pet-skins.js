import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function petSkinIds(tables, state) {
    const ids = state.petSkins ?? []
    ensure(
        Array.isArray(ids) &&
            ids.every((id) => Number.isInteger(id) && id > 0 && id <= 0xffffffff) &&
            ids.length === new Set(ids).size,
        'Invalid pet skin ownership state',
        ErrorCode.GameConfig,
    )
    for (const id of ids)
        ensure(tables.find('pet_skin', id), 'Owned pet skin configuration missing', ErrorCode.PetSkinConfNotExist)
    return [...ids].sort((a, b) => a - b)
}

export function petSkinsSnapshot(tables, state) {
    return { skin_infos: petSkinIds(tables, state).map((skin_id) => ({ skin_id })) }
}

export function grantPetSkin(tables, state, id) {
    const row = tables.find('pet_skin', id)
    ensure(row, 'Pet skin configuration does not exist', ErrorCode.PetSkinConfNotExist)
    ensure(
        [0, 1].includes(row.isNormal) && Number.isInteger(row.kiboId) && tables.find('pet', row.kiboId),
        'Invalid pet skin configuration',
        ErrorCode.GameConfig,
    )
    const ids = petSkinIds(tables, state)
    // Normal appearance is inherently available. The native page sends zero for it.
    if (row.isNormal === 1 || ids.includes(id)) return false
    state.petSkins = [...ids, id].sort((a, b) => a - b)
    state.petSkinRevision = (state.petSkinRevision ?? 0) + 1
    return true
}

export function wearPetSkin(c, r) {
    const pet = c.state.pets.find((p) => p.guid === String(r.pet_guid))
    ensure(pet, 'Pet not owned', ErrorCode.PetNotExist)
    const requested = r.skin_id ?? 0
    ensure(
        Number.isInteger(requested) && requested >= 0 && requested <= 0xffffffff,
        'Invalid pet skin ID',
        ErrorCode.InvalidArgument,
    )
    let id = requested
    if (id !== 0) {
        const row = c.tables.find('pet_skin', id)
        ensure(row, 'Pet skin configuration does not exist', ErrorCode.PetSkinConfNotExist)
        ensure(
            Number.isInteger(row.kiboId) && [0, 1].includes(row.isNormal),
            'Invalid pet skin configuration',
            ErrorCode.GameConfig,
        )
        ensure(row.kiboId === pet.config_id, 'Pet skin does not match pet', ErrorCode.PetSkinNotMatchPet)
        if (row.isNormal === 1) id = 0
        else ensure(petSkinIds(c.tables, c.state).includes(id), 'Pet skin not unlocked', ErrorCode.PetSkinNotActive)
    }
    ensure((pet.wear_skin_id ?? 0) !== id, 'Pet skin already worn', ErrorCode.PetSkinWearRepeated)
    pet.wear_skin_id = id
    // The native page uses the reply and the pet store event to refresh the current
    // formation entity. A cosmetic change must not replace GUIDs or reset combat.
    c.pushBefore('CSProtoPetInfoSync', { pet_infos: { pets: [pet] } })
    return { pet_guid: pet.guid, skin_id: id }
}
