import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { petModelEligibility } from './pet-model-eligibility.js'
import { taskPetPresentation } from './task-pet-presentation.js'

const currentIdsHash = '42a449c72ed8e91cb4e88d5606c185dc1902d599496ea76a87d7950812383ebf'
// Set difference of the complete historical259 and current258 pet catalogs.
// Historical sorted-ID SHA256:974c1e5087d3c0d1942d163c342ef1a55709367c96b66f0307eed96830d92e41.
// Identity evidence only: never read an old table or translate a saved pet ID.
const retired = new Set([
    500189, 500190, 500191, 500192, 500193, 500194, 500195, 500196, 500197, 500198, 500199, 500200, 500227, 500229,
    500230, 500835,
])
const catalogs = new WeakMap()
function currentCatalog(tables) {
    let catalog = catalogs.get(tables)
    if (catalog) return catalog
    const rows = tables.get('pet')
    ensure(
        Array.isArray(rows) &&
            rows.length > 0 &&
            rows.every((row) => Number.isSafeInteger(row?.id) && row.id > 0) &&
            new Set(rows.map((row) => row.id)).size === rows.length,
        'Current pet identity catalog is malformed',
        ErrorCode.GameConfig,
    )
    // Reuse the shared pet/unit structural validation; an unrelated missing
    // model is not grounds to reject another valid owned/sent pet.
    petModelEligibility(tables, rows[0].id)
    catalogs.set(tables, (catalog = new Set(rows.map((row) => row.id))))
    return catalog
}
function guid(value) {
    const text = String(value)
    ensure(
        /^\d+$/.test(text) &&
            BigInt(text) > 0n &&
            BigInt(text) <= 0xffffffffffffffffn &&
            (typeof value !== 'number' || Number.isSafeInteger(value)),
        'Invalid unavailable pet presentation identity',
        ErrorCode.GameConfig,
    )
    return BigInt(text).toString()
}

// Wire projection only. Lua6517 syncPetItem calls errorf (Lua error) on the
// first missing pet config, while the native Store still caches that object.
// Retain all saved assets/jobs/history; omit only proven retired identities.
// Never manufacture tombstones: Lua removePet requires a previously created
// box index, which these missing definitions could never safely initialize.
export function petModelPresentation(tables, state, payload) {
    if (payload == null) return payload
    ensure(
        typeof payload === 'object' && !Array.isArray(payload),
        'Invalid pet presentation payload',
        ErrorCode.GameConfig,
    )
    const catalog = currentCatalog(tables),
        hidden = new Set()
    ensure(Array.isArray(state.pets), 'Invalid owned pet collection', ErrorCode.GameConfig)
    const inspect = (pet) => {
        ensure(
            Number.isSafeInteger(pet?.config_id) && pet.config_id > 0,
            'Invalid pet configuration identity',
            ErrorCode.GameConfig,
        )
        if (catalog.has(pet.config_id)) {
            ensure(
                petModelEligibility(tables, pet.config_id).eligible,
                `Referenced pet model is unavailable (${pet.config_id})`,
                ErrorCode.GameConfig,
            )
            return true
        }
        ensure(retired.has(pet.config_id), 'Unknown missing pet configuration', ErrorCode.PetConfNotExist)
        hidden.add(guid(pet.guid))
        return false
    }
    for (const pet of state.pets) inspect(pet)
    const bag = payload.pet_infos
    ensure(
        bag === undefined || (bag && typeof bag === 'object' && !Array.isArray(bag)),
        'Invalid pet presentation payload',
        ErrorCode.GameConfig,
    )
    ensure(bag?.pets === undefined || Array.isArray(bag.pets), 'Invalid pet presentation rows', ErrorCode.GameConfig)
    const pets = bag?.pets?.filter(inspect)
    if (!hidden.size) return payload
    // Only the actual removal of proven historical identities needs this
    // version-specific complete-catalog evidence gate. Normal new definitions
    // and unrelated unowned model problems must not lock ordinary syncing.
    ensure(
        createHash('sha256')
            .update(JSON.stringify([...catalog].sort((a, b) => a - b)))
            .digest('hex') === currentIdsHash,
        'Retired pet presentation requires the verified current identity catalog',
        ErrorCode.GameConfig,
    )
    for (const key of ['add_guid', 'guid'])
        ensure(
            bag?.[key] === undefined || Array.isArray(bag[key]),
            'Invalid pet presentation identity list',
            ErrorCode.GameConfig,
        )
    if (!bag) return payload
    return {
        ...payload,
        pet_infos: {
            ...bag,
            ...(pets ? { pets } : {}),
            ...(bag?.add_guid ? { add_guid: bag.add_guid.filter((id) => !hidden.has(guid(id))) } : {}),
            ...(bag.guid ? { guid: bag.guid.filter((id) => !hidden.has(guid(id))) } : {}),
        },
    }
}

export function petSyncPresentation(tables, state, payload) {
    return taskPetPresentation(tables, state, petModelPresentation(tables, state, payload))
}
