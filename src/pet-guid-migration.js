import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import {
    parsePetGuid,
    petGuidOwner,
    isCanonicalPetGuid,
    planPetGuidAllocation,
    petGuidAllocationFloor,
    petProvenanceEntries,
} from './pet-guid.js'
import { isStarterPet } from './pet-catalog.js'
import { petIdentityMigration } from './pet-guid-aliases.js'
import { migratePetReferences, petReferenceAllocationFloor } from './pet-guid-references.js'
import { mutationManualState, mutationHash } from './pet-mutation-state.js'
import { mutationProofCatalog, mutationGenome, mutationBaseHash } from './pet-mutation-catalog.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const temporary = (pet) => pet.trial || pet.trail || pet.is_trial || pet.abyss || pet.type === 2
function ownedPets(state) {
    ensure(Array.isArray(state.pets), 'Malformed owned pets during identity migration', ErrorCode.GameConfig)
    const ids = new Set()
    return state.pets.filter((pet) => {
        ensure(object(pet), 'Malformed saved pet identity', ErrorCode.GameConfig)
        if (temporary(pet)) return false
        const id = parsePetGuid(pet.guid)
        ensure(
            id.guid !== '0' && [0, 2].includes(id.type) && (id.type !== 0 || id.index === 0) && !ids.has(id.guid),
            'Ambiguous or unsupported saved permanent pet identity',
            ErrorCode.GameConfig,
        )
        ids.add(id.guid)
        return true
    })
}

// Call once, at the start of the writable LOGIN transaction, before settling
// workers/catalog/tasks or building any wire/cache. A namespace change needs
// a fully restarted client; this is not an arbitrary hot-cache reset protocol.
export function migratePetGuidIdentity(tables, state, protocol) {
    const ownerId = petGuidOwner(state),
        existing = petIdentityMigration(state),
        pets = ownedPets(state)
    if (existing) {
        ensure(
            pets.every(
                (pet) => isCanonicalPetGuid(pet.guid, ownerId) && !Object.hasOwn(existing.aliases, String(pet.guid)),
            ),
            'Legacy pet appeared after completed identity migration',
            ErrorCode.GameConfig,
        )
        petGuidAllocationFloor(tables, state)
        return { changed: false, identitiesChanged: false, mapping: { ...existing.aliases } }
    }
    const sourceEntries = state.petProvenance === undefined ? {} : petProvenanceEntries(state),
        legacy = pets.filter((pet) => !isCanonicalPetGuid(pet.guid, ownerId))
    const floor = Math.max(petGuidAllocationFloor(tables, state), petReferenceAllocationFloor(state, protocol)),
        allocationState = { ...state, petGuidAllocation: { version: 1, ownerId, nextIndex: floor } },
        plan = legacy.length ? planPetGuidAllocation(tables, allocationState, legacy.length) : null,
        nextIndex = plan?.allocation.nextIndex ?? floor
    const mapping = Object.fromEntries(legacy.map((pet, index) => [String(pet.guid), plan.guids[index]])),
        pendingLinks = {},
        origins = { ...sourceEntries }
    const sources = legacy.map((pet) => ({
        originalGuid: String(pet.guid),
        currentGuid: mapping[String(pet.guid)],
        configIdAtMigration: pet.config_id,
        starter: isStarterPet(pet, state, sourceEntries),
    }))
    for (const pet of pets) {
        const old = String(pet.guid),
            current = mapping[old] ?? old
        if (isStarterPet(pet, state, sourceEntries) && !origins[current])
            origins[current] = { kind: 'legacy-starter', configId: pet.config_id }
        if (!mapping[old] || !state.petMutation?.pets?.[old]?.pending) continue
        const saved = mutationManualState(tables, state, old),
            genes = mutationGenome(mutationProofCatalog(tables), saved.pet)
        ensure(
            mutationBaseHash(saved.pet, genes) === saved.pending.baseHash,
            'Saved mutation genome does not match the original identity proof',
            ErrorCode.InvalidLogic,
        )
        pendingLinks[current] = {
            [saved.pending.generation]: {
                version: 1,
                originalGuid: old,
                baseHash: saved.pending.baseHash,
                proposalHash: mutationHash(saved.pending),
            },
        }
    }
    // Clone first: all typed references, TLV and proof validation finish before
    // even one field of the caller's transaction draft changes.
    const draft = structuredClone(state)
    draft.petGuidMigration = { version: 1, ownerId, aliases: mapping, pendingLinks, sources }
    if (state.recordPets !== undefined) {
        ensure(
            Array.isArray(state.recordPets) && state.recordPets.every((id) => Number.isSafeInteger(id) && id > 0),
            'Malformed original pet acquisition history',
            ErrorCode.GameConfig,
        )
        const missing = state.recordPets.filter((id) => !tables.find('pet', id))
        if (missing.length)
            draft.petGuidMigration.catalogHistory = {
                version: 1,
                recordPets: [...state.recordPets],
                missingConfigIds: [...new Set(missing)],
                ...(state.petCatalogVersion === undefined ? {} : { petCatalogVersion: state.petCatalogVersion }),
            }
    }
    const references = migratePetReferences(draft, mapping, protocol)
    if (references.encodedPresets.length) draft.petGuidMigration.encodedPresets = references.encodedPresets
    for (const pet of draft.pets) if (!temporary(pet) && mapping[String(pet.guid)]) pet.guid = mapping[String(pet.guid)]
    draft.petGuidAllocation = { version: 1, ownerId, nextIndex }
    draft.petProvenance = { version: 1, ownerId, entries: origins }
    petIdentityMigration(draft)
    petGuidAllocationFloor(tables, draft)
    for (const pet of draft.pets)
        if (!temporary(pet) && draft.petMutation?.pets?.[pet.guid]?.pending)
            mutationManualState(tables, draft, pet.guid)
    Object.assign(state, draft)
    return { changed: true, identitiesChanged: legacy.length > 0, mapping: { ...mapping } }
}
