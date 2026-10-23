import fs from 'node:fs'
import { temporaryHeroes, activeFormationManager } from './trial-actors.js'
const rules = new Map(
    JSON.parse(
        fs.readFileSync(new URL('../configs/battle-config/teaching-kill-conditions.json', import.meta.url)),
    ).rules.map((r) => [r.battleFsmType, r]),
)
function targets(tables, state) {
    const run = state.storyCampaign
    if (
        !run?.teaching_id ||
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
    return p?.instance === run.instance_id && p.map === run.map_id && p.source === rule.sourceSha256 ? p : null
}
export function teachingKillReady(tables, state, objectId, now) {
    const target = targets(tables, state).find((t) => t.row.id === objectId)
    if (!target) return null
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
export function teachingSceneKillReady(tables, state, now) {
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
                    !!teachingKillReady(tables, state, row.id, now))
            )
        })
    )
}
function observe(c, actor, event, key) {
    const list = targets(c.tables, c.state)
    if (!list.length) return
    const manager = activeFormationManager(c.state),
        formation = manager?.groups.find((g) => g.id === manager.cur_group)
    if (!temporaryHeroes(c.state).some((h) => h.guid === actor) || !formation?.heros.some((h) => h.hero_id === actor))
        return
    for (const { row, rule } of list) {
        if (c.state.worldObjects?.[c.state.world.map_id + ':' + row.id]?.active === false) continue
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
export function observeTeachingElement(c, e) {
    if (![1, 7, 10].includes(e.op) || !e.buff?.cfg_id || e.uniqueId === '0') return
    observe(c, e.tar_id, { kind: 'element', id: e.buff.cfg_id }, `e:${e.tar_id}:${e.uniqueId}`)
}
