import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { mutationCreditLimits, mutationPolicy } from './pet-mutation-policy.js'
import { mutationProposalProofGuid } from './pet-guid-aliases.js'

export { mutationPolicy }
export const MutationSourceSkipTag = Object.freeze({
    CounterInvalid: 'MUT_SOURCE_COUNTER_INVALID',
    LedgerInvalid: 'MUT_SOURCE_LEDGER_INVALID',
    QualificationUnverifiable: 'MUT_SOURCE_QUALIFICATION_UNVERIFIABLE',
})
export const mutationUint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
export const mutationPositive = (v) => mutationUint(v) && v > 0
export const mutationObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const mutationGuid = (v) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v) && BigInt(v) <= 0xffffffffffffffffn
const generation = (v, zero = false) =>
    typeof v === 'string' && (zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(v) && BigInt(v) <= 0xffffffffffffffffn
const hash = (text) => createHash('sha256').update(text).digest('hex')
export function mutationStableJson(value) {
    function canonical(v) {
        if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
        if (typeof v === 'number') {
            ensure(Number.isFinite(v), 'Non-finite mutation receipt value', ErrorCode.GameConfig)
            return v
        }
        if (Array.isArray(v)) return v.map(canonical)
        ensure(
            mutationObject(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)),
            'Invalid mutation receipt value',
            ErrorCode.GameConfig,
        )
        return Object.fromEntries(
            Object.keys(v)
                .sort()
                .map((k) => [k, canonical(v[k])]),
        )
    }
    return JSON.stringify(canonical(value))
}
export const mutationHash = (value) => hash(mutationStableJson(value))
const digest = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
function checkRoot(state) {
    const root = state.petMutation
    if (root === undefined) return null
    ensure(mutationObject(root), 'Malformed mutation global state', ErrorCode.GameConfig)
    ensure(root.version === 1, 'Unsupported mutation global state version', ErrorCode.FunctionClosed)
    ensure(
        generation(root.generationHighWater, true) && mutationObject(root.pets) && mutationObject(root.claimResults),
        'Malformed mutation global envelope',
        ErrorCode.GameConfig,
    )
    return root
}
export function mutationRootRead(state) {
    return checkRoot(state)
}
function writableRoot(state) {
    const old = checkRoot(state)
    const root = old
        ? { ...old, pets: { ...old.pets }, claimResults: { ...old.claimResults } }
        : { version: 1, generationHighWater: '0', pets: {}, claimResults: {} }
    state.petMutation = root
    return root
}
function publicPending(pet) {
    const value = pet.mutation_info
    if (value === undefined || value === null) return { valid: true, active: false }
    if (!mutationObject(value)) return { valid: false }
    const pos = value.pos ?? 0
    return { valid: mutationUint(pos), active: mutationPositive(pos), pos }
}
function minimalRow(row, step) {
    if (row === undefined) return { valid: true, remainder: 0, pending: false }
    if (
        !mutationObject(row) ||
        row.version !== 1 ||
        !mutationUint(row.remainder) ||
        row.remainder >= step ||
        !Object.hasOwn(row, 'pending') ||
        !Object.hasOwn(row, 'lastResolved') ||
        !mutationObject(row.resolutions)
    )
        return { valid: false }
    if (
        row.lastResolved !== null &&
        (!generation(row.lastResolved) || !mutationObject(row.resolutions[row.lastResolved]))
    )
        return { valid: false }
    if (row.pending === null) return { valid: true, remainder: row.remainder, pending: false }
    const p = row.pending
    if (
        !mutationObject(p) ||
        p.version !== 1 ||
        !generation(p.generation) ||
        !mutationGuid(p.petGuid) ||
        !mutationPositive(p.pos) ||
        !mutationObject(p.candidate) ||
        p.candidate.pos !== p.pos ||
        !mutationPositive(p.candidate.gene_id) ||
        !mutationPositive(p.candidate.gene_lv)
    )
        return { valid: false }
    return { valid: true, remainder: row.remainder, pending: true }
}
const emptyRow = () => ({ version: 1, remainder: 0, pending: null, lastResolved: null, resolutions: {} })
function lookupPet(state, guid) {
    ensure(Array.isArray(state.pets), 'Malformed owned pet collection', ErrorCode.GameConfig)
    const matches = state.pets.filter((p) => mutationObject(p) && p.guid === guid)
    ensure(matches.length <= 1, 'Duplicate permanent pet identity', ErrorCode.GameConfig)
    return matches[0] ?? null
}
export function mutationOwnedPet(state, guid) {
    ensure(mutationGuid(guid), 'Invalid mutation pet identity', ErrorCode.InvalidArgument)
    const pet = lookupPet(state, guid)
    ensure(pet, 'Mutation pet is not owned', ErrorCode.PetNotExist)
    ensure(!pet.trial && !pet.trail && pet.type !== 2, 'Temporary pet cannot mutate', ErrorCode.InvalidArgument)
    return pet
}
function bumpPet(state) {
    const old = state.petRevision ?? 0
    ensure(
        Number.isSafeInteger(old) && old >= 0 && old < Number.MAX_SAFE_INTEGER,
        'Invalid mutation pet revision',
        ErrorCode.GameConfig,
    )
    state.petRevision = old + 1
}
export function mutationWritePet(state, guid, update, changed = true) {
    const old = mutationOwnedPet(state, guid)
    const next = { ...old, ...update }
    state.pets = state.pets.map((p) => (p === old ? next : p))
    if (changed) bumpPet(state)
    return next
}
export function readMutationCreditState(tables, state, petGuid) {
    const root = checkRoot(state)
    const { cap, step } = mutationCreditLimits(tables)
    if (!mutationGuid(petGuid))
        return {
            status: 'quarantined',
            tag: MutationSourceSkipTag.QualificationUnverifiable,
            detail: 'invalid-permanent-guid',
        }
    ensure(Array.isArray(state.pets), 'Malformed owned pet collection', ErrorCode.GameConfig)
    const matches = state.pets.filter((pet) => mutationObject(pet) && pet.guid === petGuid)
    const pet = matches.length === 1 ? matches[0] : null
    if (!pet)
        return {
            status: 'quarantined',
            tag: MutationSourceSkipTag.QualificationUnverifiable,
            detail: matches.length ? 'ambiguous-permanent-identity' : 'permanent-instance-not-found',
        }
    if (pet.trial || pet.trail || pet.type === 2) return { status: 'skipped', reason: 'temporary' }
    const credits = pet.mutation_times ?? 0
    if (!mutationUint(credits))
        return { status: 'quarantined', tag: MutationSourceSkipTag.CounterInvalid, detail: 'counter-is-not-uint32' }
    const publicState = publicPending(pet)
    if (!publicState.valid)
        return { status: 'quarantined', tag: MutationSourceSkipTag.LedgerInvalid, detail: 'pending-marker-shape' }
    const row = root?.pets[petGuid]
    const data = minimalRow(row, step)
    if (!data.valid || (data.pending && row.pending.petGuid !== petGuid))
        return { status: 'quarantined', tag: MutationSourceSkipTag.LedgerInvalid, detail: 'per-pet-ledger-shape' }
    const common = { credits, remainder: data.remainder }
    if (publicState.active || data.pending) return { status: 'skipped', reason: 'pending', ...common }
    if (credits >= cap) return { status: 'skipped', reason: 'cap', ...common }
    return {
        status: 'eligible',
        ...common,
        token: mutationHash({ petGuid, credits, remainder: data.remainder, pending: false }),
    }
}
export function applyMutationCreditResult(tables, state, petGuid, plan) {
    const current = readMutationCreditState(tables, state, petGuid)
    if (current.status !== 'eligible') return current
    const { cap, step } = mutationCreditLimits(tables)
    ensure(
        mutationObject(plan) && plan.token === current.token,
        'Mutation credit state changed during its source',
        ErrorCode.InvalidLogic,
    )
    ensure(
        mutationUint(plan.credits) &&
            plan.credits >= current.credits &&
            plan.credits <= cap &&
            mutationUint(plan.remainder) &&
            plan.remainder < step,
        'Invalid mutation source credit result',
        ErrorCode.GameConfig,
    )
    const petChanged = plan.credits !== current.credits
    const changed = petChanged || plan.remainder !== current.remainder
    if (changed) {
        const root = writableRoot(state)
        root.pets[petGuid] = { ...(root.pets[petGuid] ?? emptyRow()), remainder: plan.remainder }
        if (petChanged) mutationWritePet(state, petGuid, { mutation_times: plan.credits })
    }
    return { status: 'applied', changed, petChanged, credits: plan.credits, remainder: plan.remainder }
}
export function mutationSourceReceiptKey(accountId, localClaimId) {
    const account = String(accountId)
    const local = String(localClaimId)
    ensure(
        /^[1-9][0-9]*$/.test(account) && /^[1-9][0-9]*$/.test(local) && BigInt(local) <= 0xffffffffn,
        'Invalid local paid claim identity',
        ErrorCode.GameConfig,
    )
    return hash(JSON.stringify(['pet-mutation-paid-claim-v1', account, local]))
}
export function findMutationSourceReceipt(state, key) {
    ensure(digest(key), 'Invalid mutation source receipt key', ErrorCode.GameConfig)
    const receipt = checkRoot(state)?.claimResults[key]
    if (receipt === undefined) return null
    ensure(
        mutationObject(receipt) &&
            receipt.version === 1 &&
            receipt.key === key &&
            mutationObject(receipt.primary) &&
            Array.isArray(receipt.pets) &&
            typeof receipt.primary.local_claim_id === 'string' &&
            mutationSourceReceiptKey(state.player?.basic_info?.id, receipt.primary.local_claim_id) === key,
        'Corrupt mutation claim result',
        ErrorCode.GameConfig,
    )
    return JSON.parse(mutationStableJson(receipt))
}
export function recordMutationSourceReceipt(state, key, receipt) {
    ensure(
        digest(key) &&
            mutationObject(receipt) &&
            receipt.version === 1 &&
            receipt.key === key &&
            mutationObject(receipt.primary) &&
            Array.isArray(receipt.pets),
        'Invalid mutation source receipt envelope',
        ErrorCode.GameConfig,
    )
    const local = receipt.primary.local_claim_id
    ensure(
        typeof local === 'string' && key === mutationSourceReceiptKey(state.player?.basic_info?.id, local),
        'Mutation source receipt identity mismatch',
        ErrorCode.GameConfig,
    )
    const text = mutationStableJson(receipt)
    const existing = findMutationSourceReceipt(state, key)
    if (existing !== null) {
        ensure(
            mutationStableJson(existing) === text,
            'Mutation source receipt result cannot be overwritten',
            ErrorCode.GameConfig,
        )
        return { created: false, receipt: existing }
    }
    writableRoot(state).claimResults[key] = JSON.parse(text)
    return { created: true, receipt: JSON.parse(text) }
}
export function mutationManualState(tables, state, guid) {
    const pet = mutationOwnedPet(state, guid)
    const data = readMutationCreditState(tables, state, guid)
    ensure(data.status !== 'quarantined', 'Malformed mutation state required by manual operation', ErrorCode.GameConfig)
    const root = checkRoot(state)
    const row = root?.pets[guid]
    if (row?.lastResolved)
        ensure(
            BigInt(row.lastResolved) <= BigInt(root.generationHighWater),
            'Mutation resolved generation exceeds its high water',
            ErrorCode.GameConfig,
        )
    if (row?.pending) {
        validateMutationPending(guid, row.pending)
        const proofGuid = mutationProposalProofGuid(state, guid, row.pending)
        if (proofGuid !== guid)
            ensure(
                mutationHash({ ...row.pending, petGuid: proofGuid }) ===
                    state.petGuidMigration.pendingLinks[guid][row.pending.generation].proposalHash,
                'Migrated mutation proposal differs from its original artifact',
                ErrorCode.GameConfig,
            )
        ensure(
            BigInt(row.pending.generation) <= BigInt(root.generationHighWater) &&
                !Object.hasOwn(row.resolutions, row.pending.generation),
            'Mutation proposal generation is not active',
            ErrorCode.GameConfig,
        )
    }
    if (publicPending(pet).active && !row?.pending)
        ensure(false, 'Unversioned mutation proposal requires explicit legacy handling', ErrorCode.FunctionClosed)
    if (row?.pending)
        ensure(
            publicPending(pet).active &&
                pet.mutation_info.pos === row.pending.pos &&
                pet.mutation_info.gene_id === row.pending.candidate.gene_id,
            'Owned mutation proposal projection disagrees',
            ErrorCode.GameConfig,
        )
    return { pet, credits: data.credits, row: row ?? emptyRow(), pending: row?.pending ?? null }
}
export function validateMutationPending(guid, p) {
    ensure(
        mutationObject(p) &&
            p.version === 1 &&
            p.petGuid === guid &&
            generation(p.generation) &&
            mutationPositive(p.pos) &&
            mutationObject(p.original) &&
            mutationPositive(p.original.gene_id) &&
            mutationPositive(p.original.gene_lv) &&
            mutationObject(p.candidate) &&
            p.candidate.pos === p.pos &&
            mutationPositive(p.candidate.gene_id) &&
            p.candidate.gene_lv === 1 &&
            digest(p.baseHash) &&
            digest(p.configFingerprint) &&
            mutationPositive(p.ruleId) &&
            mutationUint(p.createdAt) &&
            mutationPositive(p.counterBefore) &&
            p.counterAfter === p.counterBefore - 1,
        'Malformed owned mutation proposal',
        ErrorCode.GameConfig,
    )
    return p
}
export function mutationNextGeneration(state) {
    const value = BigInt(checkRoot(state)?.generationHighWater ?? '0')
    ensure(value < 0xffffffffffffffffn, 'Mutation generation exhausted', ErrorCode.GameConfig)
    const root = writableRoot(state)
    root.generationHighWater = (value + 1n).toString()
    return root.generationHighWater
}
export function mutationSetRow(state, guid, row) {
    ensure(mutationGuid(guid) && mutationObject(row), 'Invalid mutation ledger write', ErrorCode.GameConfig)
    writableRoot(state).pets[guid] = row
}
export function mutationHasPending(state, guid) {
    const pet = lookupPet(state, guid)
    return !!(pet && publicPending(pet).active) || !!checkRoot(state)?.pets[guid]?.pending
}
export function requireNoMutationPending(state, guid) {
    ensure(
        !mutationHasPending(state, guid),
        'Resolve pending mutation before changing its genome',
        ErrorCode.InvalidLogic,
    )
}
export function cancelRemovedMutationPet(state, guid, now) {
    const root = checkRoot(state)
    const row = root?.pets[guid]
    if (!row?.pending) return false
    validateMutationPending(guid, row.pending)
    ensure(
        BigInt(row.pending.generation) <= BigInt(root.generationHighWater) &&
            !Object.hasOwn(row.resolutions, row.pending.generation),
        'Removed pet mutation proposal is not active',
        ErrorCode.GameConfig,
    )
    ensure(mutationUint(now), 'Invalid mutation cancellation time', ErrorCode.GameConfig)
    const record = {
        version: 1,
        generation: row.pending.generation,
        kind: 'cancelled-instance-removed',
        resolvedAt: now,
        candidate: { ...row.pending.candidate },
        baseHash: row.pending.baseHash,
    }
    mutationSetRow(state, guid, {
        ...row,
        pending: null,
        lastResolved: record.generation,
        resolutions: { ...row.resolutions, [record.generation]: record },
    })
    return true
}
