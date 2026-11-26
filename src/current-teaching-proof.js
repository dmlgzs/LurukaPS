import policy from '../configs/teaching-vm-policy.json' with { type: 'json' }
import { activeFormationManager, temporaryHeroes } from './trial-actors.js'
import { enemyDefinition } from './enemy-state.js'
import { combatEnemyRoot } from './combat-enemy-lifecycle.js'
import { heroBattleConfig, heroModules } from './battle.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export const currentTeachingShape = 'current-teaching-sequence-v1'
const uint = (n) => Number.isSafeInteger(n) && n >= 0
const positive = (n) => uint(n) && n > 0

function formation(state) {
    const manager = activeFormationManager(state)
    const group = manager?.groups.find((g) => g.id === manager.cur_group)
    if (!group || !state.trialGroup?.story_campaign || !positive(state.trialGroup.current_group_id)) return null
    const ids = new Set(group.heros.map((slot) => slot.hero_id))
    const heroes = temporaryHeroes(state).filter((h) => ids.has(h.guid))
    if (!heroes.length) return null
    return {
        heroes,
        key: JSON.stringify({
            group: state.trialGroup.current_group_id,
            heroes: heroes.map((h) => [h.guid, h.conf_id]).sort(),
        }),
    }
}

// EEntityType is not FightObjType. Current enums are Hero1, Player10,
// Pet11, Monster14. BuffService.CovertUidToFightUid encodes the local Player
// as FO_Player24, independently of its currently controlled Hero UUID.
export function currentTeachingActor(tables, state, uuid) {
    const id = String(uuid ?? '0')
    if (!/^[1-9]\d*$/.test(id)) return null
    const team = formation(state)
    if (!team) return null
    const hero = team.heroes.find((h) => h.guid === id)
    if (hero) return { id, entityType: 1, heroId: hero.conf_id }
    const account = state.player.basic_info.id
    if (positive(account) && id === ((24n << 56n) | BigInt(account)).toString()) return { id, entityType: 10 }
    const kind = Number(BigInt(id) >> 56n)
    if ([3, 4, 7].includes(kind)) {
        const activation = state.combat?.enemyActivations?.[combatEnemyRoot(id)]
        const object = Number(BigInt(id) & 0xffffffffn)
        if (activation?.active === false || state.worldObjects?.[state.world.map_id + ':' + object]?.active === false)
            return null
        const enemy = enemyDefinition(tables, state, id)
        if (enemy && !enemy.npc_duel) return { id, entityType: 14 }
    }
    return null
}

function validate(rule) {
    ensure(
        rule.sourceShape === currentTeachingShape &&
            rule.proofPolicy === policy.id &&
            /^[0-9a-f]{64}$/.test(rule.sourceSha256) &&
            Array.isArray(rule.ops) &&
            rule.ops.length > 0 &&
            rule.ops.length <= 128,
        'Current teaching proof rule is malformed',
        ErrorCode.GameConfig,
    )
    for (const op of rule.ops) {
        ensure(op && typeof op === 'object', 'Current teaching trigger is malformed', ErrorCode.GameConfig)
        if (op.kind === 'wait') {
            ensure(positive(op.milliseconds), 'Current teaching wait is malformed', ErrorCode.GameConfig)
            continue
        }
        ensure(positive(op.count), 'Current teaching trigger count is malformed', ErrorCode.GameConfig)
        if (op.kind === 'skill-slot')
            ensure(uint(op.slot), 'Current teaching skill slot is malformed', ErrorCode.GameConfig)
        else if (op.kind === 'element')
            ensure(
                positive(op.id) &&
                    Array.isArray(op.executorTypes) &&
                    op.executorTypes.length > 0 &&
                    op.executorTypes.every(positive),
                'Current teaching executor predicate is malformed',
                ErrorCode.GameConfig,
            )
        else if (op.kind === 'attack-hit')
            ensure(
                positive(op.actor?.heroId) &&
                    positive(op.requiredTag) &&
                    Array.isArray(op.damageTypes) &&
                    op.damageTypes.length > 0 &&
                    op.damageTypes.every(positive) &&
                    rule.damageElements &&
                    typeof rule.damageElements === 'object',
                'Current teaching damage predicate is unavailable',
                ErrorCode.GameConfig,
            )
        else ensure(false, 'Current teaching trigger is not implemented', ErrorCode.InvalidLogic)
    }
    ensure(
        rule.ops.reduce((n, op) => n + (op.kind === 'wait' ? 0 : op.count), 0) <= policy.maxReceipts,
        'Current teaching trigger sequence exceeds receipt capacity',
        ErrorCode.GameConfig,
    )
    ensure(rule.ops[0].kind !== 'wait', 'Current teaching initial wait is unsupported', ErrorCode.InvalidLogic)
}

function proof(state, row, rule) {
    validate(rule)
    const run = state.storyCampaign
    const team = formation(state)
    if (
        !run ||
        !team ||
        !positive(run.instance_id) ||
        run.status !== 2 ||
        state.world.map_id !== run.map_id ||
        state.combat?.map_id !== run.map_id
    )
        return null
    const p = state.combat?.teachingProof?.[row.id]
    if (!p || p.instance !== run.instance_id || p.map !== run.map_id || p.source !== rule.sourceSha256) return null
    ensure(
        p.version === 3 &&
            p.policy === policy.id &&
            uint(p.op) &&
            p.op <= rule.ops.length &&
            uint(p.count) &&
            uint(p.last_event_ms) &&
            uint(p.not_before_ms) &&
            p.not_before_ms >= p.last_event_ms &&
            Array.isArray(p.receipts) &&
            p.receipts.length <= policy.maxReceipts &&
            p.receipts.every((key) => typeof key === 'string') &&
            new Set(p.receipts).size === p.receipts.length &&
            p.receipts.length >=
                rule.ops.slice(0, p.op).reduce((n, op) => n + (op.kind === 'wait' ? 0 : op.count), 0) + p.count &&
            (p.op === rule.ops.length ? p.count === 0 : p.count < rule.ops[p.op].count),
        'Current teaching proof state is malformed',
        ErrorCode.GameConfig,
    )
    // A different formation is not allowed to inherit facts, even if an actor
    // happens to reuse a config identity. A new run has its own instance scope.
    return p.formation === team.key ? p : null
}

function matches(c, actor, event, op, rule) {
    if (op.kind === 'skill-slot') {
        if (event.kind !== 'skill' || (event.slot !== undefined && event.slot !== op.slot) || actor?.entityType !== 1)
            return false
        const hero = formation(c.state).heroes.find((h) => h.guid === actor.id)
        const skills = heroModules(c.tables, c.state, hero).modules.flatMap((m) =>
            m.sub_modules.flatMap((s) => s.skills?.skills ?? []),
        )
        const battleInfo = heroBattleConfig(c.tables, hero)
        return skills.some((skill) => {
            if (skill.skill_slot !== op.slot) return false
            if (skill.skill_id === event.id) return true
            // Same canonical variant already published by heroSkills. A
            // reported slot cannot make an arbitrary skill an entry203 cast.
            return (
                battleInfo &&
                Math.floor(skill.skill_id / 100) === battleInfo.id &&
                Math.floor(battleInfo.id / 100) * 100 + (skill.skill_id % 100) === event.id &&
                skills.some((published) => published.skill_id === event.id)
            )
        })
    }
    const element = event.element
    if (!element || element.op !== 1 || !event.fresh) return false
    if (op.kind === 'element') {
        const executor = currentTeachingActor(c.tables, c.state, element.buff?.executor_id)
        return element.buff?.cfg_id === op.id && executor && op.executorTypes.includes(executor.entityType)
    }
    if (op.kind === 'attack-hit') {
        const attacker = currentTeachingActor(c.tables, c.state, element.buff?.attacker_id)
        // The outbound producer requires a valid Alive executor before packing
        // this event, independently of WaitAttackHit's attacker predicate.
        const executor = currentTeachingActor(c.tables, c.state, element.buff?.executor_id)
        const entry = rule.damageElements[element.buff?.cfg_id]
        ensure(
            !entry || (Array.isArray(entry.variants) && entry.variants.length > 0) || entry.kind === 'damage',
            'Current teaching damage variants are malformed',
            ErrorCode.GameConfig,
        )
        const variants = entry?.variants?.map((variant) => variant.config) ?? (entry?.kind === 'damage' ? [entry] : [])
        ensure(
            variants.every(
                (config) =>
                    Array.isArray(config?.tags) &&
                    config.tags.every(Number.isSafeInteger) &&
                    Number.isSafeInteger(config.damageType),
            ),
            'Current teaching damage parameters are malformed',
            ErrorCode.GameConfig,
        )
        return (
            !!executor &&
            attacker?.heroId === op.actor.heroId &&
            variants.length > 0 &&
            variants.every(
                (config) => config.tags?.includes(op.requiredTag) && op.damageTypes.includes(config.damageType),
            )
        )
    }
    return false
}

export function observeCurrentTeachingProof(c, actorId, event, key, row, rule) {
    validate(rule)
    const ms = c.arena_now_ms
    const run = c.state.storyCampaign
    const team = formation(c.state)
    if (
        !positive(run?.instance_id) ||
        !uint(ms) ||
        !team ||
        run.status !== 2 ||
        c.state.world.map_id !== run.map_id ||
        c.state.combat?.map_id !== run.map_id
    )
        return
    ensure(positive(run.start_time), 'Current teaching start time is malformed', ErrorCode.GameConfig)
    // Current SendSkillStart and MultipleSyncElement carry an absolute operation
    // time. It scopes observations to the admitted runtime; elapsed waits still
    // use only the injected server clock, never a client-supplied timestamp.
    const rawStamp = event.kind === 'skill' ? event.stamp : event.element?.verify_info?.op_time
    if (rawStamp === undefined || String(rawStamp) === '0') return
    const stamp = String(rawStamp)
    ensure(
        /^[1-9]\d*$/.test(stamp) && BigInt(stamp) <= 0xffffffffffffffffn,
        'Current teaching operation time is malformed',
        ErrorCode.GameConfig,
    )
    const rawBarrier = String(c.state.combat.runtimeActivatedAtMs ?? '0')
    ensure(/^\d+$/.test(rawBarrier), 'Current teaching runtime time is malformed', ErrorCode.GameConfig)
    const barrier = BigInt(rawBarrier)
    if (BigInt(stamp) < barrier || BigInt(stamp) < BigInt(run.start_time) * 1000n) return
    const epoch = c.state.teachingObservationEpoch
    if (epoch) {
        ensure(
            positive(epoch.instance) &&
                positive(epoch.map) &&
                /^[0-9a-f]{64}$/.test(epoch.source) &&
                typeof epoch.floor_ms === 'string' &&
                /^\d+$/.test(epoch.floor_ms) &&
                typeof epoch.high_water_ms === 'string' &&
                /^\d+$/.test(epoch.high_water_ms) &&
                BigInt(epoch.high_water_ms) >= BigInt(epoch.floor_ms) &&
                BigInt(epoch.high_water_ms) <= 0xffffffffffffffffn,
            'Current teaching observation epoch is malformed',
            ErrorCode.GameConfig,
        )
    }
    const sameEpoch =
        epoch?.instance === run.instance_id && epoch.map === run.map_id && epoch.source === rule.sourceSha256
    let floor = sameEpoch ? BigInt(epoch.floor_ms) : barrier
    if (!sameEpoch && epoch && BigInt(epoch.high_water_ms) >= floor) floor = BigInt(epoch.high_water_ms) + 1n
    if (BigInt(stamp) < floor) return
    const prior = proof(c.state, row, rule)
    const old = c.state.combat?.teachingProof?.[row.id]
    if (old?.instance === run.instance_id && old.map === run.map_id && old.source === rule.sourceSha256 && !prior)
        return
    if (prior?.blocked || (prior && ms < prior.last_event_ms)) return
    const actor = currentTeachingActor(c.tables, c.state, actorId)
    if (!rule.ops.some((op) => matches(c, actor, event, op, rule))) return
    // Injection UID and cast identity are bounded receipts. A previously
    // observed future-stage event stays consumed when that stage later opens.
    if (prior?.receipts.includes(key)) return
    const receipts = [...(prior?.receipts ?? []), key]
    if (receipts.length > policy.maxReceipts) {
        c.state.combat.teachingProof = {
            ...c.state.combat.teachingProof,
            [row.id]: { ...prior, blocked: true, blocked_reason: 'receipt-capacity-exceeded' },
        }
        return
    }
    let op = prior?.op ?? 0
    let count = prior?.count ?? 0
    let deadline = prior?.not_before_ms ?? ms
    if (ms >= deadline && matches(c, actor, event, rule.ops[op] ?? {}, rule)) {
        count++
        if (count === rule.ops[op].count) {
            count = 0
            op++
            deadline = ms
            while (rule.ops[op]?.kind === 'wait') deadline += rule.ops[op++].milliseconds
        }
    }
    ensure(uint(deadline), 'Current teaching wait exceeds clock range', ErrorCode.GameConfig)
    c.state.combat.teachingProof = {
        ...c.state.combat.teachingProof,
        [row.id]: {
            version: 3,
            policy: policy.id,
            formation: team.key,
            instance: run.instance_id,
            map: run.map_id,
            source: rule.sourceSha256,
            op,
            count,
            receipts,
            last_event_ms: Math.max(prior?.last_event_ms ?? 0, ms),
            not_before_ms: Math.max(deadline, ms),
        },
    }
    c.state.teachingObservationEpoch = {
        instance: run.instance_id,
        map: run.map_id,
        source: rule.sourceSha256,
        floor_ms: floor.toString(),
        high_water_ms: (epoch && BigInt(epoch.high_water_ms) > BigInt(stamp)
            ? BigInt(epoch.high_water_ms)
            : BigInt(stamp)
        ).toString(),
    }
}

export function currentTeachingProofReady(state, row, rule, nowMs) {
    const p = proof(state, row, rule)
    return !!p && !p.blocked && p.op === rule.ops.length && uint(nowMs) && nowMs >= p.not_before_ms
}

// The blueprint may report its final UI target before the FSM's final wait and
// StoryKillReq. This only admits a pending intent; kill/reward readiness retains
// the deadline above. Intermediate waits still leave a trigger op outstanding.
export function currentTeachingIntentReady(state, row, rule) {
    const p = proof(state, row, rule)
    return !!p && !p.blocked && p.op === rule.ops.length
}
