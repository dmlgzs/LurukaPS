import policy from '../configs/hero-favor-reward-policy.json' with { type: 'json' }
import { heroFavorabilityPlan } from './hero-favorability.js'
import { repeatEntryFavorCandidates } from './repeat-formation.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

// LOCAL policy explicitly selected by the user. A stable entry roster proves
// recipients, not the official per-person/share amount or daily limit.
export function repeatFavorRewardContext(tables, state, operation) {
    ensure(
        policy.allocation === 'entry-favor-roster-each-v1',
        'Personal favor allocation policy unavailable',
        ErrorCode.FunctionClosed,
    )
    const candidates = repeatEntryFavorCandidates(tables, state)
    ensure(
        candidates.status === 'verified-entry-candidates',
        'Repeat favor requires a verified entry formation; leave and enter a fresh run',
        ErrorCode.FunctionClosed,
    )
    ensure(
        typeof operation === 'string' && /^[a-z][a-z0-9-]*$/.test(operation),
        'Invalid favor receipt operation',
        ErrorCode.GameConfig,
    )
    for (const id of candidates.hero_guids) heroFavorabilityPlan(tables, state, id, 0)
    return {
        policy: policy.allocation,
        instanceId: candidates.instance_id,
        heroGuids: [...candidates.hero_guids],
        operation,
        ordinal: 0,
    }
}

export function grantEntryHeroFavor(tables, state, amount, context) {
    ensure(
        context?.policy === policy.allocation && policy.allocation === 'entry-favor-roster-each-v1',
        'Invalid explicit personal favor policy',
        ErrorCode.FunctionClosed,
    )
    ensure(
        typeof context.operation === 'string' &&
            /^[a-z][a-z0-9-]*$/.test(context.operation) &&
            Number.isSafeInteger(context.ordinal) &&
            context.ordinal >= 0,
        'Invalid personal favor receipt context',
        ErrorCode.GameConfig,
    )
    const run = state.entrust?.run
    ensure(
        run?.kind === 'repeat' && run.instance_id === context.instanceId,
        'Personal favor context no longer matches the run',
        ErrorCode.GameConfig,
    )
    const expected = repeatEntryFavorCandidates(tables, state)
    ensure(
        expected.status === 'verified-entry-candidates' &&
            JSON.stringify(expected.hero_guids) === JSON.stringify(context.heroGuids),
        'Personal favor recipients do not match the verified entry',
        ErrorCode.GameConfig,
    )
    const key = context.operation + ':' + context.ordinal++
    const receipts = run.repeat_favor_receipts ?? {}
    ensure(
        receipts && typeof receipts === 'object' && !Array.isArray(receipts),
        'Invalid personal favor receipt ledger',
        ErrorCode.GameConfig,
    )
    const old = receipts[key]
    if (old) {
        ensure(
            Array.isArray(old.heroes) && old.heroes.every((row) => row && typeof row.hero_guid === 'string'),
            'Invalid saved personal favor receipt',
            ErrorCode.GameConfig,
        )
        ensure(
            old.policy === policy.allocation &&
                old.instance_id === context.instanceId &&
                old.amount === amount &&
                JSON.stringify(old.heroes.map((row) => row.hero_guid)) === JSON.stringify(context.heroGuids),
            'Personal favor receipt does not match the reward',
            ErrorCode.GameConfig,
        )
        return old
    }
    // Plan all heroes first. Callers use complete inventory transactions;
    // replacement also avoids modifying a borrowed combat hero object.
    const plans = context.heroGuids.map((id) => heroFavorabilityPlan(tables, state, id, amount))
    const receipt = {
        policy: policy.allocation,
        instance_id: context.instanceId,
        operation: context.operation,
        amount,
        heroes: plans.map((plan) => ({
            hero_guid: plan.heroGuid,
            requested: amount,
            applied: plan.applied,
            capped: plan.capped,
            before_lv: plan.beforeLevel,
            before_exp: plan.beforeExp,
            after_lv: plan.level,
            after_exp: plan.exp,
            unlocked_reward_ids: [...plan.unlockedRewardIds],
        })),
    }
    const updates = new Map(plans.filter((plan) => plan.applied > 0).map((plan) => [plan.heroGuid, plan.updates]))
    const heroes = state.player.heros_info.heros
    state.player.heros_info = {
        ...state.player.heros_info,
        heros: heroes.map((hero) => (updates.has(hero.guid) ? { ...hero, ...updates.get(hero.guid) } : hero)),
    }
    run.repeat_favor_receipts = { ...receipts, [key]: receipt }
    return receipt
}
