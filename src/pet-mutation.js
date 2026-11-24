import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { petGrade } from './pets.js'
import { petInActiveNpcDuel } from './npc-kibo-duel.js'
import { effectGeneSkills } from './pet-dna-skills.js'
import {
    mutationCatalog,
    mutationGenome,
    mutationSlotDomain,
    mutationBaseHash,
    mutationDraw,
    mutationWeighted,
} from './pet-mutation-catalog.js'
import {
    mutationManualState,
    mutationNextGeneration,
    mutationSetRow,
    mutationWritePet,
    mutationHash,
    mutationObject,
    mutationPositive,
    mutationUint,
} from './pet-mutation-state.js'

// Approved offline local strategy, not recovered official generation logic.
// TODO(mutation-runtime): 2026-11-24 feeding updated PetStore but retained
// the old world skill object. Do not use10800/CD reset or respawn as proof.
// TODO(release): ordinary live old-passive removal/new-ID installation, other
// effect origins, HP/SP/control/CD preservation and client callback ordering.
// Stored descriptor transitions are a review plan, never a fake runtime UID.
// TODO(replay): current wire has no proposal generation/client intent nonce;
// only the existing transport ReplayWindow can identify exact local retries.

function context(tables, state, guid) {
    const saved = mutationManualState(tables, state, guid)
    ensure(!petInActiveNpcDuel(state, guid), 'Pet is in the active duel roster', ErrorCode.PetInBattle)
    ensure(
        tables.find('pet', saved.pet.config_id),
        'Mutation pet configuration is unavailable',
        ErrorCode.PetConfNotExist,
    )
    return saved
}
function visibleEmpty() {
    return { pos: 0, gene_id: 0 }
}
function validPlan(plan) {
    ensure(
        mutationObject(plan) &&
            plan.version === 1 &&
            ['append', 'replace'].includes(plan.kind) &&
            mutationPositive(plan.pos) &&
            mutationObject(plan.candidate) &&
            plan.candidate.pos === plan.pos &&
            mutationPositive(plan.candidate.gene_id) &&
            plan.candidate.gene_lv === 1 &&
            mutationPositive(plan.counterBefore) &&
            plan.counterAfter === plan.counterBefore - 1 &&
            mutationPositive(plan.ruleId) &&
            mutationUint(plan.createdAt),
        'Invalid mutation plan',
        ErrorCode.GameConfig,
    )
}
function contains(domain, geneId) {
    return (
        domain &&
        (domain.innate
            ? domain.candidate === geneId
            : domain.groups.some((g) => g.choices.some((r) => r.dna === geneId)))
    )
}
function effectTransition(tables, oldPet, newPet) {
    return {
        status: 'unverified-client-transition-release-gate',
        old: effectGeneSkills(tables, oldPet),
        next: effectGeneSkills(tables, newPet),
    }
}
export function planMutationGeneration(tables, state, guid, rng, now) {
    ensure(mutationUint(now) && typeof rng === 'function', 'Invalid mutation generation context', ErrorCode.GameConfig)
    const saved = context(tables, state, guid)
    ensure(!saved.pending, 'Resolve the existing mutation proposal first', ErrorCode.InvalidLogic)
    ensure(saved.credits > 0, 'Mutation credits exhausted', ErrorCode.PetNoMutationTimes)
    const catalog = mutationCatalog(tables),
        genes = mutationGenome(catalog, saved.pet)
    const kind = genes.length < catalog.max ? 'append' : 'replace'
    const domains =
        kind === 'append'
            ? [mutationSlotDomain(catalog, saved.pet, genes, genes.length + 1)].filter(Boolean)
            : genes.map((row) => mutationSlotDomain(catalog, saved.pet, genes, row.pos)).filter(Boolean)
    ensure(domains.length > 0, 'No legal unlocked mutation result', ErrorCode.PetGeneAddFail)
    const domain = domains.length === 1 ? domains[0] : domains[mutationDraw(rng, domains.length)]
    const geneId = domain.innate
        ? domain.candidate
        : mutationWeighted(rng, mutationWeighted(rng, domain.groups).choices).dna
    return {
        version: 1,
        kind,
        petGuid: guid,
        pos: domain.pos,
        original: genes[domain.pos - 1] ? { ...genes[domain.pos - 1] } : null,
        candidate: { pos: domain.pos, gene_id: geneId, gene_lv: 1 },
        baseHash: mutationBaseHash(saved.pet, genes),
        configFingerprint: catalog.fingerprint,
        counterBefore: saved.credits,
        counterAfter: saved.credits - 1,
        ruleId: catalog.ruleId,
        createdAt: now,
    }
}
export function applyMutationGeneration(tables, state, plan) {
    validPlan(plan)
    const saved = context(tables, state, plan.petGuid)
    ensure(!saved.pending, 'Resolve the existing mutation proposal first', ErrorCode.InvalidLogic)
    ensure(saved.credits === plan.counterBefore, 'Mutation credit balance changed before apply', ErrorCode.InvalidLogic)
    const catalog = mutationCatalog(tables),
        genes = mutationGenome(catalog, saved.pet)
    ensure(
        catalog.ruleId === plan.ruleId && catalog.fingerprint === plan.configFingerprint,
        'Mutation rule changed before apply',
        ErrorCode.GameConfig,
    )
    ensure(
        mutationBaseHash(saved.pet, genes) === plan.baseHash,
        'Mutation genome changed before apply',
        ErrorCode.InvalidLogic,
    )
    ensure(
        plan.kind === (genes.length < catalog.max ? 'append' : 'replace'),
        'Mutation capacity changed before apply',
        ErrorCode.InvalidLogic,
    )
    ensure(
        contains(mutationSlotDomain(catalog, saved.pet, genes, plan.pos), plan.candidate.gene_id),
        'Mutation candidate is not legal in the current genome',
        ErrorCode.GameConfig,
    )
    if (plan.kind === 'replace') {
        const original = genes[plan.pos - 1]
        ensure(
            mutationObject(plan.original) &&
                original &&
                plan.original.pos === original.pos &&
                plan.original.gene_id === original.gene_id &&
                plan.original.gene_lv === original.gene_lv,
            'Mutation original slot changed before apply',
            ErrorCode.GameConfig,
        )
    } else {
        ensure(
            plan.original === null && plan.pos === genes.length + 1,
            'Mutation append position is inconsistent',
            ErrorCode.GameConfig,
        )
        ensure(mutationUint(saved.pet.gene_state ?? 0), 'Invalid legacy gene display state', ErrorCode.GameConfig)
    }
    const id = mutationNextGeneration(state)
    if (plan.kind === 'replace') {
        const pending = { ...plan, generation: id }
        mutationSetRow(state, plan.petGuid, { ...saved.row, pending })
        mutationWritePet(state, plan.petGuid, {
            mutation_times: plan.counterAfter,
            mutation_info: { pos: plan.pos, gene_id: plan.candidate.gene_id },
        })
        return { kind: 'proposal', generation: id, candidate: { ...plan.candidate } }
    }
    ensure(plan.pos === genes.length + 1, 'Mutation append position is inconsistent', ErrorCode.GameConfig)
    const newGenes = [...genes, { ...plan.candidate }]
    const oldGeneState = saved.pet.gene_state ?? 0
    ensure(mutationUint(oldGeneState), 'Invalid legacy gene display state', ErrorCode.GameConfig)
    const update = {
        gene_infos: newGenes,
        mutation_times: plan.counterAfter,
        mutation_info: visibleEmpty(),
        gene_state: Math.max(oldGeneState, Math.ceil(plan.pos / 2)),
        grade: petGrade(tables, { ...saved.pet, gene_infos: newGenes }),
    }
    const record = {
        version: 1,
        generation: id,
        kind: 'append',
        candidate: { ...plan.candidate },
        baseHash: plan.baseHash,
        configFingerprint: plan.configFingerprint,
        ruleId: plan.ruleId,
        counterBefore: plan.counterBefore,
        counterAfter: plan.counterAfter,
        createdAt: plan.createdAt,
        resolvedAt: plan.createdAt,
        projection: effectTransition(tables, saved.pet, { ...saved.pet, ...update }),
    }
    mutationWritePet(state, plan.petGuid, update)
    mutationSetRow(state, plan.petGuid, {
        ...saved.row,
        pending: null,
        lastResolved: id,
        resolutions: { ...saved.row.resolutions, [id]: record },
    })
    return { kind: 'append', generation: id, candidate: { ...plan.candidate }, projection: record.projection }
}
export function generateMutation(tables, state, guid, rng, now) {
    return applyMutationGeneration(tables, state, planMutationGeneration(tables, state, guid, rng, now))
}
export function confirmMutation(tables, state, guid, accept, now) {
    ensure(typeof accept === 'boolean', 'Mutation choice must be boolean', ErrorCode.InvalidArgument)
    ensure(mutationUint(now), 'Invalid mutation resolution time', ErrorCode.GameConfig)
    const saved = context(tables, state, guid),
        pending = saved.pending
    // Same-session exact retransmission is handled by the real ReplayWindow.
    // A GUID/choice without a pending generation cannot identify an old intent.
    ensure(pending, 'Pet has no mutation proposal', ErrorCode.PetCanNotMutation)
    let update = { mutation_info: visibleEmpty() },
        projection = null
    if (accept) {
        const catalog = mutationCatalog(tables),
            genes = mutationGenome(catalog, saved.pet)
        ensure(
            catalog.ruleId === pending.ruleId && catalog.fingerprint === pending.configFingerprint,
            'Stored mutation rule is no longer current',
            ErrorCode.GameConfig,
        )
        ensure(
            mutationBaseHash(saved.pet, genes) === pending.baseHash,
            'Mutation genome changed while awaiting choice',
            ErrorCode.InvalidLogic,
        )
        ensure(
            contains(mutationSlotDomain(catalog, saved.pet, genes, pending.pos), pending.candidate.gene_id),
            'Stored mutation candidate is not currently legal',
            ErrorCode.InvalidLogic,
        )
        const oldGene = genes[pending.pos - 1]
        ensure(
            oldGene && oldGene.gene_id === pending.original.gene_id && oldGene.gene_lv === pending.original.gene_lv,
            'Stored mutation source slot disagrees',
            ErrorCode.GameConfig,
        )
        const next = genes.map((row) => (row.pos === pending.pos ? { ...pending.candidate } : row))
        update = { ...update, gene_infos: next, grade: petGrade(tables, { ...saved.pet, gene_infos: next }) }
        if (saved.pet.ur_pos === pending.pos) {
            ensure(
                catalog.dna.get(oldGene.gene_id).rarity === 6,
                'Unverified shining source marker',
                ErrorCode.FunctionClosed,
            )
            update.ur_pos = 0
        }
        // A different marker is part of the base hash and was left unchanged.
        projection = effectTransition(tables, saved.pet, { ...saved.pet, ...update })
    }
    const record = {
        version: 1,
        generation: pending.generation,
        kind: accept ? 'accepted' : 'retained',
        choice: accept,
        candidate: { ...pending.candidate },
        original: { ...pending.original },
        baseHash: pending.baseHash,
        outcomeHash: mutationHash({
            config_id: saved.pet.config_id,
            genes: update.gene_infos ?? saved.pet.gene_infos ?? [],
            ur_pos: update.ur_pos ?? saved.pet.ur_pos ?? 0,
        }),
        counterAtResolution: saved.credits,
        ruleId: pending.ruleId,
        configFingerprint: pending.configFingerprint,
        createdAt: pending.createdAt,
        resolvedAt: now,
        projection,
    }
    mutationWritePet(state, guid, update)
    mutationSetRow(state, guid, {
        ...saved.row,
        pending: null,
        lastResolved: pending.generation,
        resolutions: { ...saved.row.resolutions, [pending.generation]: record },
    })
    return { kind: record.kind, generation: record.generation, projection }
}
