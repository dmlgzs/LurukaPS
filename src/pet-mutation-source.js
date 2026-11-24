import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { activeFormationManager } from './trial-actors.js'
import {
    mutationPolicy,
    readMutationCreditState,
    applyMutationCreditResult,
    findMutationSourceReceipt,
    recordMutationSourceReceipt,
    MutationSourceSkipTag,
} from './pet-mutation-state.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const amount = (value) => Number.isSafeInteger(value) && value >= 0
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const identity = (value) => {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) return null
        value = String(value)
    }
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null
    return BigInt(value) <= 0xffffffffffffffffn ? value : null
}
const rawField = (value, key) =>
    Object.hasOwn(value, key) ? { present: true, value: structuredClone(value[key]) } : { present: false }
function rawPetAudit(pet) {
    return Object.fromEntries(
        [
            'config_id',
            'lv',
            'gene_infos',
            'ur_pos',
            'mutation_times',
            'mutation_info',
            'hero_id',
            'type',
            'trial',
            'trail',
        ].map((key) => [key, rawField(pet, key)]),
    )
}

// Normal slots mirror the owned hero binding. Explicit trial/instance groups
// have their own slot overrides and must never be mapped back to owned pets.
export function captureMutationClaimPets(state, now) {
    ensure(uint(now), 'Invalid mutation claim time', ErrorCode.GameConfig)
    ensure(
        Array.isArray(state.player?.group_mgrs) &&
            Array.isArray(state.player?.heros_info?.heros) &&
            Array.isArray(state.pets) &&
            uint(state.player?.basic_info?.id) &&
            state.player.basic_info.id > 0,
        'Mutation source formation state unavailable',
        ErrorCode.GameConfig,
    )
    const manager = activeFormationManager(state)
    ensure(
        manager && Array.isArray(manager.groups),
        'Mutation source formation manager unavailable',
        ErrorCode.GameConfig,
    )
    const group = manager.groups.find((row) => row.id === manager.cur_group)
    ensure(group && Array.isArray(group.heros), 'Mutation source current formation unavailable', ErrorCode.GameConfig)
    let temporary = null
    if (manager.type === 7) temporary = state.abyssRun
    else if (manager.type === 8) temporary = state.cultTrial
    else if (manager.type === 1 && group.id === 0) temporary = state.trialGroup
    const tempHeroes = temporary?.heroes ?? [],
        tempPets = temporary?.pets ?? []
    ensure(
        Array.isArray(tempHeroes) && Array.isArray(tempPets),
        'Mutation source temporary registry malformed',
        ErrorCode.GameConfig,
    )
    const normal = manager.type === 1 && group.id !== 0
    const members = new Map(),
        issues = [],
        excluded = []
    for (const [index, slot] of group.heros.entries()) {
        if (!object(slot)) {
            issues.push({
                slot_index: index,
                tag: MutationSourceSkipTag.QualificationUnverifiable,
                detail: 'active-slot-shape',
                raw: structuredClone(slot),
            })
            continue
        }
        const heroId = identity(slot.hero_id ?? '0')
        if (heroId === '0') continue
        const ownedHeroes = state.player.heros_info.heros.filter(
            (hero) => object(hero) && identity(hero.guid) === heroId,
        )
        const currentTemporary = tempHeroes.filter((hero) => object(hero) && identity(hero.guid) === heroId)
        const hero =
            currentTemporary.length === 1 ? currentTemporary[0] : ownedHeroes.length === 1 ? ownedHeroes[0] : null
        const petId = identity(normal && hero ? (hero.pet_id ?? '0') : (slot.pet_id ?? '0'))
        if (petId === '0') continue
        const binding = {
            slot_index: index,
            hero_guid: heroId,
            slot_hero: rawField(slot, 'hero_id'),
            slot_pet: rawField(slot, 'pet_id'),
            hero_pet: hero ? rawField(hero, 'pet_id') : { present: false },
            authority: normal ? 'owned-hero-binding-with-normal-slot-mirror' : 'current-explicit-slot-override',
        }
        if (!petId) {
            issues.push({
                ...binding,
                tag: MutationSourceSkipTag.QualificationUnverifiable,
                detail: 'active-pet-guid-not-u64',
            })
            continue
        }
        if (tempPets.some((pet) => object(pet) && identity(pet.guid) === petId)) {
            excluded.push({ pet_guid: petId, binding, reason: 'current-temporary-instance-no-owned-remap' })
            continue
        }
        const owned = state.pets.filter((pet) => object(pet) && identity(pet.guid) === petId)
        const existing = members.get(petId) ?? { pet_guid: petId, bindings: [], invalid_bindings: [], audit: null }
        members.set(petId, existing)
        if (owned.length !== 1) {
            existing.invalid_bindings.push({
                ...binding,
                detail: owned.length ? 'ambiguous-permanent-instance' : 'permanent-instance-not-found',
            })
            continue
        }
        const pet = owned[0]
        existing.audit = rawPetAudit(pet)
        if (pet.trial === true || pet.trail === true || pet.type === 2) {
            members.delete(petId)
            excluded.push({ pet_guid: petId, binding, reason: 'temporary-instance-no-owned-remap' })
            continue
        }
        const flagsValid =
            (pet.trial === undefined || typeof pet.trial === 'boolean') &&
            (pet.trail === undefined || typeof pet.trail === 'boolean') &&
            (pet.type === undefined || pet.type === 1)
        const bindingValid =
            heroId &&
            hero &&
            ownedHeroes.length <= 1 &&
            currentTemporary.length <= 1 &&
            pet.guid === petId &&
            flagsValid &&
            identity(pet.hero_id ?? '0') === heroId &&
            (!normal || identity(hero.pet_id ?? '0') === petId)
        if (!bindingValid) {
            existing.invalid_bindings.push({ ...binding, detail: 'permanent-binding-not-provable' })
            continue
        }
        if (!existing.bindings.some((row) => row.hero_guid === heroId)) existing.bindings.push(binding)
    }
    const beneficiaries = [...members.values()]
        .sort((a, b) => (BigInt(a.pet_guid) < BigInt(b.pet_guid) ? -1 : 1))
        .map((entry) => ({
            ...entry,
            status: entry.bindings.length === 1 && entry.invalid_bindings.length === 0 ? 'eligible' : 'quarantined',
            ...(entry.bindings.length === 1 && entry.invalid_bindings.length === 0
                ? {}
                : {
                      tag: MutationSourceSkipTag.QualificationUnverifiable,
                      detail: 'current-unique-permanent-binding-unverifiable',
                  }),
        }))
    return structuredClone({
        version: 1,
        owner_id: state.player.basic_info.id,
        captured_at: now,
        manager_type: manager.type,
        group_id: group.id,
        beneficiaries,
        excluded,
        issues,
    })
}

function paidComponents(costs) {
    ensure(Array.isArray(costs), 'Mutation source actual fee components unavailable', ErrorCode.GameConfig)
    let paid = 0
    const rows = costs.map((cost, index) => {
        ensure(
            object(cost) &&
                uint(cost.itemtype) &&
                cost.itemtype > 0 &&
                uint(cost.itemid) &&
                cost.itemid > 0 &&
                uint(cost.itemnum),
            'Malformed mutation source actual fee component',
            ErrorCode.GameConfig,
        )
        if (cost.itemtype === 10 && cost.itemid === 3) paid += cost.itemnum
        ensure(amount(paid), 'Mutation source total actual fee overflow', ErrorCode.GameConfig)
        return { index, itemtype: cost.itemtype, itemid: cost.itemid, itemnum: cost.itemnum }
    })
    return { paid, rows }
}

const defaultCore = {
    mutationPolicy,
    readMutationCreditState,
    applyMutationCreditResult,
    findMutationSourceReceipt,
    recordMutationSourceReceipt,
}
export function createMutationSourceRuntime(overrides = {}) {
    const core = { ...defaultCore, ...overrides }
    for (const name of Object.keys(defaultCore))
        ensure(
            typeof core[name] === 'function',
            'Mutation source shared ABI unavailable: ' + name,
            ErrorCode.GameConfig,
        )
    const contexts = new WeakMap(),
        claims = new WeakMap()
    return Object.freeze({
        prepare(c, descriptor) {
            const fee = paidComponents(descriptor.costs)
            if (fee.paid === 0) return null
            const run = c.state.entrust?.run
            ensure(
                run &&
                    descriptor.run === run &&
                    run.battle_complete === true &&
                    run.chest_claimed !== true &&
                    run.map_id === c.state.world.map_id,
                'Mutation source is not a current successful paid claim',
                ErrorCode.InvalidLogic,
            )
            ensure(
                ['entrust', 'material', 'weekly', 'repeat'].includes(descriptor.kind) &&
                    uint(descriptor.box_id) &&
                    descriptor.box_id > 0 &&
                    uint(descriptor.times) &&
                    descriptor.times > 0,
                'Mutation source primary claim description is invalid',
                ErrorCode.GameConfig,
            )
            const signature = JSON.stringify([descriptor.kind, descriptor.box_id, descriptor.times, fee.rows])
            const byRun = contexts.get(c) ?? new Map()
            contexts.set(c, byRun)
            const old = byRun.get(run)
            if (old && !old.finished) {
                ensure(
                    old.signature === signature && old.paid.size === 0,
                    'Overlapping mutation paid claim context',
                    ErrorCode.InvalidLogic,
                )
                return old.handle
            }
            const policy = core.mutationPolicy(),
                parameters = mutationSourceParameters(c.tables, policy)
            const snapshot = captureMutationClaimPets(c.state, c.now)
            ensure(snapshot.owner_id === c.id, 'Mutation paid claim owner mismatch', ErrorCode.GameConfig)
            ensure(
                typeof c.allocateMutationSourceClaim === 'function',
                'Mutation paid-claim allocator is not installed',
                ErrorCode.GameConfig,
            )
            const localClaimId = c.allocateMutationSourceClaim()
            const key = mutationSourceClaimKey(c.id, localClaimId)
            ensure(
                core.findMutationSourceReceipt(c.state, key) === null,
                'Mutation paid-claim identity already committed',
                ErrorCode.GameConfig,
            )
            const handle = Object.freeze({ key, local_claim_id: localClaimId })
            const primary = {
                account_id: c.id,
                local_claim_id: localClaimId,
                kind: descriptor.kind,
                box_id: descriptor.box_id,
                times: descriptor.times,
                paid_stamina: fee.paid,
                actual_costs: fee.rows,
                map_id: run.map_id,
                dungeon_id: run.dungeon_id ?? null,
                entrust_id: run.entrust_id ?? null,
                instance_id: uint(run.instance_id) && run.instance_id > 0 ? run.instance_id : null,
                instance_raw: rawField(run, 'instance_id'),
                captured_at: c.now,
                rule_fingerprint: parameters.fingerprint,
                qualification_snapshot: snapshot,
            }
            const current = {
                handle,
                c,
                run,
                signature,
                fee,
                primary,
                parameters,
                snapshot,
                paid: new Set(),
                finished: false,
            }
            byRun.set(run, current)
            claims.set(handle, current)
            return handle
        },
        paid(c, handle, index, actualCost) {
            if (handle === null) return
            const claim = claims.get(handle)
            ensure(
                claim && claim.c === c && !claim.finished,
                'Mutation paid component lacks its current claim context',
                ErrorCode.InvalidLogic,
            )
            const expected = claim.fee.rows[index]
            ensure(
                expected &&
                    expected.itemnum > 0 &&
                    !claim.paid.has(index) &&
                    actualCost.itemtype === expected.itemtype &&
                    actualCost.itemid === expected.itemid &&
                    actualCost.itemnum === expected.itemnum,
                'Mutation paid component does not match the actual debit callback',
                ErrorCode.GameConfig,
            )
            claim.paid.add(index)
        },
        complete(c, handle) {
            if (handle === null) return null
            const claim = claims.get(handle)
            ensure(claim && claim.c === c, 'Mutation result lacks its paid claim context', ErrorCode.InvalidLogic)
            if (claim.finished) return core.findMutationSourceReceipt(c.state, handle.key)
            ensure(
                claim.run === c.state.entrust?.run &&
                    claim.run.chest_claimed === true &&
                    claim.run.claim_times === claim.primary.times &&
                    claim.fee.rows.every((row) => row.itemnum === 0 || claim.paid.has(row.index)),
                'Mutation source has no completed primary payment receipt',
                ErrorCode.InvalidLogic,
            )
            const beforeRevision = c.state.petRevision ?? 0,
                changedGuids = [],
                results = []
            for (const member of claim.snapshot.beneficiaries) {
                if (member.status === 'quarantined') {
                    results.push({
                        pet_guid: member.pet_guid,
                        status: 'quarantined',
                        tag: member.tag,
                        detail: member.detail,
                        no_backfill: true,
                    })
                    continue
                }
                const credit = core.readMutationCreditState(c.tables, c.state, member.pet_guid)
                if (credit.status !== 'eligible') {
                    results.push({ pet_guid: member.pet_guid, ...credit, no_backfill: true })
                    continue
                }
                const plan = planMutationEarning(
                    { credits: credit.credits, remainder: credit.remainder, pending: false, paid: claim.fee.paid },
                    claim.parameters,
                    c.randomInt,
                )
                const applied = core.applyMutationCreditResult(c.tables, c.state, member.pet_guid, {
                    token: credit.token,
                    credits: plan.after.credits,
                    remainder: plan.after.remainder,
                })
                ensure(
                    applied.status === 'applied',
                    'Mutation credit state changed during its atomic source plan',
                    ErrorCode.InvalidLogic,
                )
                if (applied.petChanged) changedGuids.push(member.pet_guid)
                results.push({ pet_guid: member.pet_guid, status: 'planned', plan, applied })
            }
            const receipt = { version: 1, key: handle.key, primary: claim.primary, pets: results }
            core.recordMutationSourceReceipt(c.state, handle.key, receipt)
            claim.run.mutation_source_claim = { version: 1, key: handle.key, local_claim_id: handle.local_claim_id }
            claim.finished = true
            if (changedGuids.length) {
                const old = c.mutationSourcePetSync
                c.mutationSourcePetSync =
                    old && old.expectedRevision !== beforeRevision
                        ? { disabled: true }
                        : {
                              version: 1,
                              beforeRevision: old?.beforeRevision ?? beforeRevision,
                              expectedRevision: c.state.petRevision ?? 0,
                              guids: [...new Set([...(old?.guids ?? []), ...changedGuids])],
                          }
            }
            return structuredClone(receipt)
        },
    })
}

export function mutationSourceParameters(tables, policy) {
    ensure(
        policy && (policy.userApproved === true || policy.approved === true) && policy.officiallyVerified === false,
        'Mutation source local policy is not approved',
        ErrorCode.FunctionClosed,
    )
    const source = policy.source
    ensure(
        source && typeof source === 'object' && !Array.isArray(source),
        'Missing mutation source policy',
        ErrorCode.GameConfig,
    )
    const rows = tables.get('game').filter((row) => row.title === 'KIBO_DNA_MUTATION_TIMES_LIMIT')
    ensure(
        rows.length === 1 && /^[1-9][0-9]*$/.test(String(rows[0].value)),
        'Mutation credit cap unavailable',
        ErrorCode.GameConfig,
    )
    const result = {
        step: source.staminaPerTrial,
        numerator: source.successNumerator,
        denominator: source.successDenominator,
        cap: Number(rows[0].value),
    }
    requireParameters(result)
    // A semantic fingerprint deliberately excludes recordedAt, approval prose
    // and all other human-review metadata.
    result.fingerprint = createHash('sha256')
        .update(
            JSON.stringify([
                'pet-mutation-source-rule-v1',
                policy.version,
                result.step,
                result.numerator,
                result.denominator,
                result.cap,
            ]),
        )
        .digest('hex')
    return result
}

function requireParameters(parameters) {
    ensure(
        parameters &&
            uint(parameters.step) &&
            parameters.step > 0 &&
            uint(parameters.denominator) &&
            parameters.denominator > 0 &&
            uint(parameters.numerator) &&
            parameters.numerator <= parameters.denominator &&
            uint(parameters.cap) &&
            parameters.cap > 0,
        'Malformed mutation source parameters',
        ErrorCode.GameConfig,
    )
}

// This plans a single already-validated beneficiary. It neither owns a ledger
// nor touches a wallet. The adapter must preserve this result in the original
// paid-claim transaction through the shared mutation-state ABI.
export function planMutationEarning(input, parameters, rng) {
    requireParameters(parameters)
    const { step, numerator, denominator, cap } = parameters
    ensure(
        input &&
            uint(input.credits) &&
            uint(input.remainder) &&
            input.remainder < step &&
            typeof input.pending === 'boolean' &&
            amount(input.paid),
        'Malformed mutation source credit input',
        ErrorCode.GameConfig,
    )
    ensure(typeof rng === 'function', 'Mutation source random generator unavailable', ErrorCode.GameConfig)
    const before = { credits: input.credits, remainder: input.remainder }
    const unchanged = (status) => ({
        status,
        paid: input.paid,
        before,
        after: { ...before },
        trials: 0,
        successes: 0,
        discarded: input.paid,
        changed: false,
        petChanged: false,
    })
    if (input.paid === 0) return unchanged('unfunded')
    if (input.pending) return unchanged('pending')
    if (input.credits >= cap) return unchanged('cap')
    const total = input.remainder + input.paid
    ensure(amount(total), 'Mutation source amount overflow', ErrorCode.GameConfig)
    const opportunities = Math.floor(total / step)
    let credits = input.credits,
        trials = 0,
        successes = 0,
        remainder = total % step,
        discarded = 0
    // Current callers supply actual bounded chest fees. Each 40-unit trial is
    // an independent integer draw; no quality RNG or per-roll SQL occurs here.
    for (; trials < opportunities;) {
        const roll = rng(denominator)
        ensure(uint(roll) && roll < denominator, 'Invalid mutation source random result', ErrorCode.GameConfig)
        trials++
        if (roll < numerator) {
            credits++
            successes++
            if (credits === cap) {
                discarded = total - trials * step
                remainder = 0
                break
            }
        }
    }
    ensure(
        total === trials * step + remainder + discarded && credits <= cap,
        'Mutation source accounting is inconsistent',
        ErrorCode.GameConfig,
    )
    return {
        status:
            credits === cap ? 'cap-reached' : successes ? 'credited' : opportunities ? 'no-success' : 'remainder-only',
        paid: input.paid,
        before,
        after: { credits, remainder },
        trials,
        successes,
        discarded,
        changed: credits !== input.credits || remainder !== input.remainder,
        petChanged: credits !== input.credits,
    }
}

export function mutationSourceClaimKey(accountId, localClaimId) {
    ensure(uint(accountId) && accountId > 0, 'Invalid mutation source account', ErrorCode.GameConfig)
    ensure(
        typeof localClaimId === 'string' && /^[1-9][0-9]*$/.test(localClaimId) && BigInt(localClaimId) <= 0xffffffffn,
        'Invalid mutation paid-claim identity',
        ErrorCode.GameConfig,
    )
    return createHash('sha256')
        .update(JSON.stringify(['pet-mutation-paid-claim-v1', String(accountId), localClaimId]))
        .digest('hex')
}
