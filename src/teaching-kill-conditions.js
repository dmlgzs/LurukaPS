import fs from 'node:fs'
import { temporaryHeroes, activeFormationManager } from './trial-actors.js'
import policy from '../configs/teaching-vm-policy.json' with { type: 'json' }
const rules = new Map(
    JSON.parse(
        fs.readFileSync(new URL('../configs/battle-config/teaching-kill-conditions.json', import.meta.url)),
    ).rules.map((r) => [r.battleFsmType, r]),
)
function targets(tables, state) {
    const run = state.storyCampaign
    if (
        !run?.teaching_id ||
        !validInstance(run.instance_id) ||
        run.status !== 2 ||
        run.map_id !== state.world.map_id ||
        state.combat?.map_id !== run.map_id
    )
        return []
    const train = tables.get('train_task').find((t) => t.taskid === run.teaching_id)
    if (train?.dungeonId !== run.dungeon_id || !run.scenes.includes(run.map_id)) return []
    const [kind, spawner, , target] = String(tables.find('dungeon_scene', run.map_id)?.victoryCondition)
        .split('#')
        .map(Number)
    if (kind !== 2500) return []
    return tables
        .get('worldmap_' + run.map_id)
        .filter((row) => row.spawnerId === spawner && (!target || row.id === target))
        .flatMap((row) => {
            const group = tables.find('world_enemy_group', row.expandId),
                rule = rules.get(group?.battleFsmType)
            return group?.canForceKill === 1 && rule ? [{ row, group, rule }] : []
        })
}
function validProof(state, row, rule) {
    const p = state.combat?.teachingProof?.[row.id],
        run = state.storyCampaign
    return p &&
        run &&
        validInstance(run.instance_id) &&
        p.instance === run.instance_id &&
        p.map === run.map_id &&
        p.source === rule.sourceSha256
        ? p
        : null
}
function validInstance(id) {
    return Number.isSafeInteger(id) && id > 0
}
function activeTrialActor(state, actor) {
    const manager = activeFormationManager(state),
        formation = manager?.groups.find((g) => g.id === manager.cur_group)
    return temporaryHeroes(state).some((h) => h.guid === actor) && formation?.heros.some((h) => h.hero_id === actor)
}
function timedProof(state, row, rule) {
    const p = validProof(state, row, rule)
    if (
        p?.version !== 2 ||
        p.policy !== policy.id ||
        rule.proofPolicy !== policy.id ||
        !Number.isSafeInteger(p.op) ||
        p.op < 0 ||
        p.op > rule.ops.length ||
        !Number.isSafeInteger(p.last_event_ms) ||
        !Number.isSafeInteger(p.not_before_ms) ||
        p.last_event_ms < 0 ||
        p.not_before_ms < p.last_event_ms ||
        !Array.isArray(p.receipts) ||
        p.receipts.length > policy.maxReceipts ||
        p.receipts.some((r) => typeof r !== 'string') ||
        !activeTrialActor(state, p.actor)
    )
        return null
    return p
}
function validTime(ms) {
    return Number.isSafeInteger(ms) && ms >= 0
}
export function teachingKillReady(tables, state, objectId, now, nowMs) {
    const target = targets(tables, state).find((t) => t.row.id === objectId)
    if (!target) return null
    if (target.rule.ops) {
        const proof = timedProof(state, target.row, target.rule)
        return proof &&
            !proof.blocked &&
            proof.op === target.rule.ops.length &&
            validTime(nowMs) &&
            nowMs >= proof.not_before_ms &&
            nowMs >= proof.last_event_ms
            ? target
            : null
    }
    const proof = validProof(state, target.row, target.rule),
        delay = target.rule.completionDelaySeconds ?? 0
    return proof?.step === target.rule.steps.length &&
        (!delay ||
            (Number.isSafeInteger(proof.completed_at) &&
                Number.isSafeInteger(now) &&
                now >= proof.completed_at + delay))
        ? target
        : null
}
export function teachingSceneKillReady(tables, state, now, nowMs) {
    const run = state.storyCampaign
    if (!run?.teaching_id) return false
    const rows = tables
        .get('worldmap_' + run.map_id)
        .filter(
            (row) =>
                tables.find('world_spawner', row.spawnerId)?.objectType === 50 &&
                state.worldObjects?.[run.map_id + ':' + row.id]?.active !== false,
        )
    return (
        rows.length > 0 &&
        rows.every((row) => {
            const packs = String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
            return (
                packs.length > 0 &&
                (packs.every((pack, slot) => {
                    const e = state.combat?.entities[((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString()]
                    return e?.hp === 0 && e.alive_state === 1 && !e.captured && e.pack_id === Number(pack)
                }) ||
                    !!teachingKillReady(tables, state, row.id, now, nowMs))
            )
        })
    )
}
function observe(c, actor, event, key) {
    const list = targets(c.tables, c.state)
    if (!list.length) return
    if (!activeTrialActor(c.state, actor)) return
    for (const { row, rule } of list) {
        if (c.state.worldObjects?.[c.state.world.map_id + ':' + row.id]?.active === false) continue
        if (rule.ops) {
            observeTimedTeachingProof(c, actor, event, key, row, rule)
            continue
        }
        if (event.recordOnly) continue
        const prior = validProof(c.state, row, rule),
            step = prior?.step ?? 0,
            wanted = rule.steps[step]
        if (
            !wanted ||
            wanted.kind !== event.kind ||
            wanted.id !== event.id ||
            (wanted.kind === 'skill' && wanted.index !== event.index)
        )
            continue
        if (prior?.receipts.includes(key)) continue
        // Copy only this bounded proof. SkillStart remains on the deferred memory
        // path; encoding failures cannot leak progress into the borrowed base state.
        c.state.combat.teachingProof = {
            ...c.state.combat.teachingProof,
            [row.id]: {
                instance: c.state.storyCampaign.instance_id,
                map: c.state.world.map_id,
                source: rule.sourceSha256,
                step: step + 1,
                receipts: [...(prior?.receipts ?? []), key],
                ...(rule.completionDelaySeconds && step + 1 === rule.steps.length ? { completed_at: c.now } : {}),
            },
        }
    }
}
export function observeTimedTeachingProof(c, actor, event, key, row, rule) {
    const ms = c.arena_now_ms
    if (
        !validInstance(c.state.storyCampaign?.instance_id) ||
        !validTime(ms) ||
        rule.proofPolicy !== policy.id ||
        !activeTrialActor(c.state, actor)
    )
        return
    const prior = timedProof(c.state, row, rule)
    if (prior?.blocked || (prior && (prior.actor !== actor || ms < prior.last_event_ms))) return
    const op = prior?.op ?? 0,
        wanted = rule.ops[op],
        matches = (candidate) =>
            candidate &&
            candidate.kind === event.kind &&
            candidate.id === event.id &&
            (candidate.kind !== 'skill' || candidate.index === event.index) &&
            (candidate.kind !== 'element' ||
                (JSON.stringify(candidate.executorTypes) === '[1]' &&
                    event.heroExecutor &&
                    (candidate.networkOperation === event.operation ||
                        (event.retired && candidate.networkOperation === 1))))
    if (!wanted || !rule.ops.some(matches)) return
    if (prior?.receipts.includes(key)) return
    // Only this bounded proof is replaced. No timers, SQL or full-state clone are
    // introduced on the high-frequency skill/element observation paths.
    const receipts = [...(prior?.receipts ?? []), key]
    if (receipts.length > policy.maxReceipts) {
        c.state.combat.teachingProof = {
            ...c.state.combat.teachingProof,
            [row.id]: { ...prior, blocked: true, blocked_reason: 'receipt-capacity-exceeded' },
        }
        return
    }
    const early =
        event.recordOnly ||
        (event.kind === 'element' && !event.fresh) ||
        !matches(wanted) ||
        (prior && ms < prior.not_before_ms)
    let next = op,
        deadline = prior?.not_before_ms ?? ms
    if (!early) {
        next++
        deadline = ms
        while (rule.ops[next]?.kind === 'wait') {
            deadline += rule.ops[next].milliseconds
            next++
        }
    }
    c.state.combat.teachingProof = {
        ...c.state.combat.teachingProof,
        [row.id]: {
            version: 2,
            policy: policy.id,
            actor,
            instance: c.state.storyCampaign.instance_id,
            map: c.state.world.map_id,
            source: rule.sourceSha256,
            op: next,
            receipts,
            last_event_ms: early && prior ? prior.last_event_ms : ms,
            not_before_ms: deadline,
        },
    }
}
export function observeTeachingSkill(c, id, r) {
    const cast = String(r.skill?.begin_time ?? r.op_time ?? '0')
    // A cast timestamp is required for retry-safe counting. Do not use frame
    // sequence numbers: a client resend may arrive under a different sequence.
    if (cast === '0') return
    observe(
        c,
        id,
        { kind: 'skill', id: r.skill.skill_id, index: r.skill.index ?? 0 },
        `s:${id}:${r.skill.skill_id}:${r.skill.index ?? 0}:${cast}`,
    )
}
export function observeTeachingElement(c, e, previous) {
    if (e.op === 2 && previous?.buff?.cfg_id && e.uniqueId !== '0') {
        observe(
            c,
            previous.tar_id,
            {
                kind: 'element',
                id: previous.buff.cfg_id,
                heroExecutor: previous.buff.executor_id === previous.tar_id,
                operation: 2,
                retired: true,
                recordOnly: true,
                fresh: false,
            },
            `e:${previous.tar_id}:${e.uniqueId}`,
        )
        return
    }
    if (![1, 7, 10].includes(e.op) || !e.buff?.cfg_id || e.uniqueId === '0') return
    observe(
        c,
        e.tar_id,
        {
            kind: 'element',
            id: e.buff.cfg_id,
            heroExecutor: e.buff.executor_id === e.tar_id,
            operation: e.op,
            fresh: !previous,
        },
        `e:${e.tar_id}:${e.uniqueId}`,
    )
}
