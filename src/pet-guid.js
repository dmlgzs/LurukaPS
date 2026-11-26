import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const MAX_INDEX = 0xffffff
const MAX_OWNER = 0xffffffff
const LEGACY_SPECIES_MAX = 500835
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_OWNER
const origins = new Set(['server-starter', 'acquired', 'legacy-starter', 'legacy-nonstarter'])

export function petGuidOwner(state) {
    const owner = state.player?.basic_info?.id
    ensure(positive(owner), 'Permanent pet owner identity is unavailable', ErrorCode.GameConfig)
    return owner
}
export function parsePetGuid(value) {
    const text = String(value)
    ensure(
        /^\d+$/.test(text) &&
            BigInt(text) <= 0xffffffffffffffffn &&
            (typeof value !== 'number' || Number.isSafeInteger(value)),
        'Invalid pet identity',
        ErrorCode.GameConfig,
    )
    const id = BigInt(text)
    return {
        guid: id.toString(),
        type: Number(id >> 56n),
        index: Number((id >> 32n) & 0xffffffn),
        ownerId: Number(id & 0xffffffffn),
    }
}
export function isCanonicalPetGuid(value, ownerId) {
    const id = parsePetGuid(value)
    return id.type === 2 && id.ownerId === ownerId
}
export function permanentPetGuid(ownerId, index) {
    ensure(positive(ownerId), 'Invalid permanent pet owner', ErrorCode.GameConfig)
    ensure(
        Number.isSafeInteger(index) && index >= 1 && index <= MAX_INDEX,
        'Pet instance index is outside 24-bit space',
        ErrorCode.GameConfig,
    )
    return ((2n << 56n) | (BigInt(index) << 32n) | BigInt(ownerId)).toString()
}
function map(value, label) {
    ensure(value === undefined || object(value), 'Malformed pet identity ' + label, ErrorCode.GameConfig)
    return value ?? {}
}
function list(value, label) {
    ensure(value === undefined || Array.isArray(value), 'Malformed pet identity ' + label, ErrorCode.GameConfig)
    return value ?? []
}
function provenance(state, ownerId) {
    const saved = state.petProvenance
    if (saved === undefined) return { version: 1, ownerId, entries: {} }
    ensure(
        object(saved) && saved.version === 1 && saved.ownerId === ownerId && object(saved.entries),
        'Malformed pet provenance envelope',
        ErrorCode.GameConfig,
    )
    for (const [guid, row] of Object.entries(saved.entries))
        ensure(
            isCanonicalPetGuid(guid, ownerId) &&
                parsePetGuid(guid).guid === guid &&
                object(row) &&
                origins.has(row.kind) &&
                positive(row.configId),
            'Malformed pet provenance entry',
            ErrorCode.GameConfig,
        )
    return saved
}
export function petProvenance(state, guid) {
    return provenance(state, petGuidOwner(state)).entries[String(guid)] ?? null
}
export function petProvenanceEntries(state) {
    return provenance(state, petGuidOwner(state)).entries
}
function allocation(state, ownerId) {
    const saved = state.petGuidAllocation
    if (saved === undefined) return null
    ensure(
        object(saved) &&
            saved.version === 1 &&
            saved.ownerId === ownerId &&
            Number.isSafeInteger(saved.nextIndex) &&
            saved.nextIndex >= 1 &&
            saved.nextIndex <= MAX_INDEX + 1,
        'Malformed permanent pet allocator',
        ErrorCode.GameConfig,
    )
    return saved
}
function baseIndex(tables) {
    const rows = tables.get('pet')
    ensure(
        Array.isArray(rows) &&
            rows.length > 0 &&
            rows.every((row) => positive(row?.id)) &&
            new Set(rows.map((row) => row.id)).size === rows.length,
        'Malformed pet identity catalog',
        ErrorCode.GameConfig,
    )
    // Local allocation policy, not an official server counter: stay above
    // every known old/current species prefix used by the previous allocator.
    // Historical 259-ID catalog SHA256: 974c1e5087d3c0d1942d163c342ef1a55709367c96b66f0307eed96830d92e41.
    return Math.max(LEGACY_SPECIES_MAX, ...rows.map((row) => row.id)) + 1
}
export function reservedPermanentPetGuids(state) {
    const owner = petGuidOwner(state),
        source = provenance(state, owner),
        result = new Set()
    const keep = (value) => {
        if (value === undefined || value === null || value === '0' || value === 0) return
        const id = parsePetGuid(value)
        if (id.type === 2 && id.ownerId === owner) result.add(id.guid)
    }
    for (const id of Object.keys(source.entries)) keep(id)
    for (const pet of list(state.pets, 'owned roster')) keep(pet.guid)
    for (const id of Object.keys(map(state.petStarSoulProgress?.entries, 'star-soul entries'))) keep(id)
    for (const receipt of Object.values(map(state.hatchReceipts, 'hatch receipts'))) {
        ensure(object(receipt), 'Malformed hatch identity receipt', ErrorCode.GameConfig)
        keep(receipt.petGuid)
    }
    for (const receipt of Object.values(map(state.petCaptureResults, 'capture receipts'))) {
        ensure(object(receipt), 'Malformed capture identity receipt', ErrorCode.GameConfig)
        keep(receipt.guid)
    }
    for (const receipt of Object.values(map(state.playableChoiceReceipts, 'playable choice receipts'))) {
        ensure(object(receipt), 'Malformed playable pet identity receipt', ErrorCode.GameConfig)
        keep(receipt.pet_guid)
    }
    // Do not resolve/cancel mutation proposals or change their hashes. Reading
    // their identities is sufficient to reserve space while migration is separate.
    for (const [id, row] of Object.entries(map(state.petMutation?.pets, 'mutation entries'))) {
        keep(id)
        ensure(object(row), 'Malformed mutation identity entry', ErrorCode.GameConfig)
        keep(row.pending?.petGuid)
    }
    for (const receipt of Object.values(map(state.petMutation?.claimResults, 'mutation receipts'))) {
        ensure(object(receipt), 'Malformed mutation identity receipt', ErrorCode.GameConfig)
        for (const row of list(receipt.pets, 'mutation receipt pets')) keep(row.pet_guid ?? row.petGuid)
    }
    return result
}
export function petGuidAllocationFloor(tables, state) {
    const owner = petGuidOwner(state),
        saved = allocation(state, owner)
    let next = Math.max(baseIndex(tables), saved?.nextIndex ?? 1)
    for (const guid of reservedPermanentPetGuids(state)) next = Math.max(next, parsePetGuid(guid).index + 1)
    return next
}
export function planPetGuidAllocation(tables, state, count) {
    ensure(Number.isSafeInteger(count) && count > 0, 'Invalid pet identity allocation count', ErrorCode.GameConfig)
    ensure(
        state.nextPetSequence === undefined ||
            (Number.isSafeInteger(state.nextPetSequence) &&
                state.nextPetSequence > 0 &&
                state.nextPetSequence <= MAX_OWNER + 1),
        'Invalid legacy pet allocation counter',
        ErrorCode.GameConfig,
    )
    const ownerId = petGuidOwner(state),
        next = petGuidAllocationFloor(tables, state)
    ensure(
        next <= MAX_INDEX && count - 1 <= MAX_INDEX - next,
        'Permanent pet identity space exhausted',
        ErrorCode.GameConfig,
    )
    const guids = Array.from({ length: count }, (_, index) => permanentPetGuid(ownerId, next + index))
    return {
        ownerId,
        guids,
        allocation: { version: 1, ownerId, nextIndex: next + count },
        previous: state.petGuidAllocation,
    }
}
export function commitPetGuidAllocation(state, plan, kind, configIds) {
    const owner = petGuidOwner(state),
        saved = provenance(state, owner)
    ensure(
        plan.ownerId === owner &&
            state.petGuidAllocation === plan.previous &&
            ['server-starter', 'acquired'].includes(kind) &&
            Array.isArray(configIds) &&
            configIds.length === plan.guids.length &&
            configIds.every(positive),
        'Pet identity allocation plan is no longer applicable',
        ErrorCode.GameConfig,
    )
    const entries = { ...saved.entries }
    for (const [index, guid] of plan.guids.entries()) {
        ensure(!entries[guid], 'Permanent pet identity was already issued', ErrorCode.GameConfig)
        // Version1 allocates ordinary acquired pets by monotonic high-water.
        // Only exceptions need per-instance provenance; released captures must
        // not leave a second indefinitely growing allocation receipt ledger.
        if (kind === 'server-starter') entries[guid] = { kind, configId: configIds[index] }
    }
    state.petGuidAllocation = plan.allocation
    state.petProvenance = { ...saved, entries }
}
