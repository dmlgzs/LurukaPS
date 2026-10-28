import { recordNoviceNpcAcceptedSkill } from './novice-duel-events.js'
import { ErrorCode } from './error-codes.js'
import { arenaContext, arenaMillis, secondsToArenaMs } from './npc-kibo-time.js'
import fs from 'node:fs'
import { ensure } from './handlers/common.js'
import { arenaSkillLogic } from './kibo-arena-attributes.js'
import { evaluateArenaFormula } from './npc-kibo-formulas.js'

const { skills } = JSON.parse(
    fs.readFileSync(new URL('../configs/npc-arena-trainer-skills.json', import.meta.url), 'utf8'),
)

export function recordArenaTrainerSkill(c, uuid, request) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel,
        id = request.skill?.skill_id,
        profile = skills[id]
    if (!run || !profile || run.map_id !== c.state.world.map_id) return
    if (run.result || c.state.multiCampaign?.arena_status !== 4 || run.entities_sent === false) return
    ensure(uuid === run.trainer_guid, 'Arena trainer skill actor mismatch')
    if (request.verify_info?.source_type === 5) return // Network acknowledgement, not another cast.
    ensure(!run.pause && !c.state.world.pause?.operate, 'Arena trainer is paused')
    const infos =
        run.trainer_skill_infos ?? c.state.kiboDuelGroups?.[c.state.multiCampaign.formation_slot]?.hero_skills ?? []
    const selected = infos.find((skill) => skill.skill_id === id)
    ensure(selected, 'Arena trainer skill is not equipped')
    ensure(!request.skill.slot || request.skill.slot === selected.skill_slot, 'Arena trainer skill slot mismatch')
    const index = String(request.verify_info?.battle_index ?? '0')
    if (index !== '0' && run.trainer_casts?.some((cast) => cast.id === id && cast.index === index)) return
    const logic = arenaSkillLogic(c.tables, id)
    ensure(
        logic?.coolDownHint === -1 && logic.coolDownCountDefault > 0,
        'Arena trainer cooldown unavailable',
        ErrorCode.GameConfig,
    )
    const previous = run.trainer_skills?.[id] ?? {
        charges: Math.min(logic.coolDownCount, logic.coolDownCountDefault),
        ready_at: secondsToArenaMs(run.regular_started_at ?? c.now) + logic.kiBoCoolDownDefault,
    }
    const now = arenaMillis(c)
    const serial = (run.trainer_cast_serial ?? 0) + 1
    ensure(previous.charges > 0, 'Arena trainer skill has no remaining charges')
    ensure(now >= previous.ready_at, 'Arena trainer skill is cooling down')
    const effects = profile.effects.map(({ value_formula, parameters, ...effect }) => ({
        ...effect,
        value: evaluateArenaFormula(value_formula, { parameter: (index) => parameters[index] }),
    }))
    const accepted = {
        ...run,
        trainer_skills: {
            ...run.trainer_skills,
            [id]: { charges: previous.charges - 1, ready_at: now + logic.kiBoVersusCoolDown },
        },
        trainer_cast_serial: serial,
        trainer_casts: [
            ...(run.trainer_casts ?? []),
            { id, index, serial, client_at_ms: String(request.op_time ?? '0'), paused_client_ms: '0' },
        ].slice(-64),
        trainer_effects: [
            ...(run.trainer_effects ?? []),
            ...effects.map((effect) => ({
                ...effect,
                camp: 1,
                cast_serial: serial,
                at_ms: now + (effect.frame * 1000) / profile.fps,
            })),
        ],
    }
    c.state.combat.npcDuel = recordNoviceNpcAcceptedSkill(accepted, id, serial, now)
}

export function recordArenaTrainerStop(c, uuid, request) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run || uuid !== run.trainer_guid || run.map_id !== c.state.world.map_id || run.result) return
    const index = String(request.verify_info?.related_index ?? '0')
    if (index === '0') return // Native SendSkillStop always identifies its cast.
    const cast = run.trainer_casts?.findLast(
        (cast) => String(cast.id) === String(request.skill_id) && cast.index === index,
    )
    if (!cast || cast.stopped || !cast.client_at_ms || cast.client_at_ms === '0' || !request.op_time) return
    const stopTime = BigInt(request.op_time),
        startTime = BigInt(cast.client_at_ms)
    const pausedAt = run.pause?.client_at_ms && run.pause.client_at_ms !== '0' ? BigInt(run.pause.client_at_ms) : null
    const begin = pausedAt === null ? stopTime : pausedAt > startTime ? pausedAt : startTime
    const ongoing = stopTime > begin ? stopTime - begin : 0n
    const elapsed = stopTime - startTime - BigInt(cast.paused_client_ms ?? '0') - ongoing
    if (elapsed < 0n) return
    const profile = skills[cast.id]
    c.state.combat.npcDuel = {
        ...run,
        trainer_casts: run.trainer_casts.map((entry) => (entry === cast ? { ...entry, stopped: true } : entry)),
        trainer_effects: (run.trainer_effects ?? []).filter(
            (effect) =>
                effect.cast_serial !== cast.serial ||
                elapsed * BigInt(profile.fps) >= BigInt(effect.frame * 1000) ||
                effect.at_ms <= (run.energy?.[effect.camp]?.at ?? 0) * 1000,
        ),
    }
}
