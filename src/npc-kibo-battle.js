import { ErrorCode } from './error-codes.js'
import { recordNoviceNpcDeployment } from './novice-duel-events.js'
import { recordActiveProgress, notifyActive } from './daily-active.js'
import { arenaContext, arenaMillis, arenaActionMillis } from './npc-kibo-time.js'
import { arenaScoreOutcome, sealArenaScoreOutcome } from './npc-kibo-outcome-time.js'
import { ensure } from './handlers/common.js'
import { combatState } from './combat-state.js'
import { npcDuelEntry, selectedArenaGroup } from './npc-kibo-duel.js'
import { arenaPetAttributes, arenaSkillLevels } from './kibo-arena-attributes.js'
import { beginNpcArenaPresentation, publishNpcArenaPresentation } from './npc-kibo-presentation.js'
import { stopArenaPetAI } from './npc-kibo-pet-ai.js'
import { publishArenaStatistics } from './npc-kibo-statistics.js'
import { advanceArenaSp, arenaSpConfig, publishArenaSp } from './npc-kibo-sp.js'
import { arenaSummonPositionAllowed } from './npc-kibo-geometry.js'
import { updateNpcArenaPause } from './npc-kibo-pause.js'
import { clearArenaCardControls, publishArenaControls } from './npc-kibo-controls.js'
import { arenaBaseProperties, arenaBasePropertyValue } from './npc-kibo-properties.js'
import { resetArenaOrigins } from './npc-kibo-origins.js'
import { publishArenaStageBuffs, arenaFeverInfo } from './npc-kibo-stage-buffs.js'
import {
    startArenaClock,
    consumeArenaPoint,
    advanceArenaEnergy,
    publishArenaEnergy,
    publishArenaCostStage,
    arenaHand,
    advanceArenaScores,
} from './npc-kibo-clock.js'

export function arenaPoint(tables, map, field, angleScale = 1) {
    const read = (key) => {
        const tuple = String(map[key]).split('|').map(Number)
        const point = tables
            .get('world_pos_path')
            .find((row) => row.sceneId === map.prefabID && row.group === tuple[1] && row.index === tuple[2])
        const xyz = String(point?.posPoint ?? '')
            .split('|')
            .map(Number)
        ensure(
            tuple.length === 3 && point && xyz.length === 3 && xyz.every(Number.isFinite),
            'Arena spawn point unavailable',
            ErrorCode.GameConfig,
        )
        return {
            xyz,
            rotation: String(point.posRot ?? '')
                .split('|')
                .map(Number),
        }
    }
    const { xyz, rotation } = read(field)
    const opposite = {
        nestBorthPos1: 'nestBorthPos2',
        nestBorthPos2: 'nestBorthPos1',
        SummonPos1: 'SummonPos2',
        SummonPos2: 'SummonPos1',
    }[field]
    let degrees = rotation[1] || 0
    if (opposite) {
        const target = read(opposite).xyz,
            dx = target[0] - xyz[0],
            dz = target[2] - xyz[2]
        ensure(Math.hypot(dx, dz) > 0, 'Arena opposing spawn points coincide', ErrorCode.GameConfig)
        degrees = ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360
    }
    // ProtoHelper.ToClientRot divides normal world movement by100. Arena
    // OnObjAppear/OnInFightChange instead consume plain-degree rotations.
    ensure(angleScale === 1 || angleScale === 100, 'Invalid arena angle unit', ErrorCode.GameConfig)
    return {
        pos: { x: Math.round(xyz[0] * 100), y: Math.round(xyz[1] * 100), z: Math.round(xyz[2] * 100) },
        angle: Math.round(degrees * angleScale) % (360 * angleScale),
    }
}

export function initializeNpcDuelBattle(tables, state, selfAttributes, now) {
    const campaign = state.multiCampaign
    const battle = combatState(state, now)
    if (battle.npcDuel?.duel_id === campaign.duel_id && battle.npcDuel.start_time === campaign.start_time)
        return battle.npcDuel
    const { duel, map, enemyPets } = npcDuelEntry(tables, campaign.duel_id)
    const generation = (state.nextNpcDuelGeneration ?? 0) + 1
    ensure(generation <= 0x7ffff, 'NPC duel identity space exhausted', ErrorCode.GameConfig)
    state.nextNpcDuelGeneration = generation
    const account = state.player.basic_info.id
    // Local NPC identity must fit KiboDuelPVPPlayerInfo.player_id (uint32).
    // It is also the master UUID used by SyncArenaPetInfos/IsNpcSummon.
    ensure(account < 1000000000, 'NPC duel account identity outside local range', ErrorCode.GameConfig)
    const npcId = 1000000000 + account
    const guid = (slot) => ((20n << 56n) | (BigInt(generation * 32 + slot) << 32n) | BigInt(account)).toString()
    const positions = {
        self: arenaPoint(tables, map, 'nestBorthPos1'),
        enemy: arenaPoint(tables, map, 'nestBorthPos2'),
        selfSummon: arenaPoint(tables, map, 'SummonPos1'),
        enemySummon: arenaPoint(tables, map, 'SummonPos2'),
    }
    const actors = {},
        enemyInfos = []
    const add = (info, slot, camp, point) => {
        const uuid = guid(slot)
        const baseProperties = arenaBaseProperties(tables, info.attrs)
        // SPSystem.InitKiboRingConfig replaces the wire MAXSP external base.
        baseProperties[6] = { base: arenaSpConfig(tables, info.pet_conf_id).max, extra: 0, percent: 0 }
        const skillLevels = arenaSkillLevels(tables, info.skills)
        const maxHp = arenaBasePropertyValue(tables, baseProperties, 5)
        ensure(
            Number.isSafeInteger(maxHp) && maxHp > 0 && maxHp <= 0xffffffff,
            'Arena actor HP unavailable',
            ErrorCode.GameConfig,
        )
        actors[uuid] = {
            uuid,
            source_guid: info.pet_guid.guid,
            config_id: info.pet_conf_id,
            level: info.pet_lv,
            camp,
            native_owner: { status: 'known', guid: '0', kind: 'none', via: 'arena-roster' },
            max_hp: maxHp,
            base_properties: baseProperties,
            skill_levels: skillLevels,
            pos: point.pos,
            angle: point.angle,
            slot,
        }
        battle.entities[uuid] = {
            uuid,
            hp: maxHp,
            sp: arenaSpConfig(tables, info.pet_conf_id).initial,
            alive_state: 0,
            updated_at: now,
            owner_id: camp === 1 ? selfAttributes.hero_info.hero_guid : String(npcId),
            npc_duel: true,
        }
    }
    selfAttributes.infos.forEach((info, index) => add(info, index + 1, 1, positions.self))
    enemyPets.forEach((petId, index) => {
        const source = guid(index + 9),
            attributes = arenaPetAttributes(tables, petId, duel.recommendLevel)
        const info = {
            pet_guid: { guid: source, id: source, is_trial: false },
            pet_conf_id: petId,
            pet_lv: duel.recommendLevel,
            attrs: attributes.attrs,
            skills: attributes.skills,
            pet_color: 0,
            special: 0,
            gene_list: [],
        }
        enemyInfos.push(info)
        add(info, index + 9, 2, positions.enemy)
    })
    const initialScore = Number(
        tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_SCORE_START')?.value,
    )
    ensure(
        Number.isInteger(initialScore) && initialScore > 0,
        'Arena score configuration unavailable',
        ErrorCode.GameConfig,
    )
    return (battle.npcDuel = {
        version: 1,
        duel_id: duel.id,
        map_id: state.world.map_id,
        generation,
        start_time: campaign.start_time,
        npc_id: npcId,
        trainer_guid: selfAttributes.hero_info.hero_guid,
        trainer_grade: selfAttributes.hero_info.hero_grade,
        trainer_skill_infos: structuredClone(selfAttributes.hero_info.skills ?? []),
        formation_snapshot: structuredClone(selectedArenaGroup(state)),
        actors,
        enemy_attributes: { infos: enemyInfos, hero_info: { hero_guid: String(npcId), hero_lv: duel.recommendLevel } },
        positions,
        in_fight: {},
        summon_actions: {},
        last_summon_at: {},
        dead: {},
        scores: { 1: initialScore, 2: initialScore },
    })
}

export function npcArenaPlayers(state, selfAttributes, tables) {
    const run = state.combat.npcDuel
    const duel = tables.find('kibo_duel', run.duel_id)
    return {
        player_info: [
            {
                player_id: state.player.basic_info.id,
                player_camp: 1,
                dungeon_id: state.multiCampaign.dungeon_id,
                attr: selfAttributes,
                name: Buffer.from(state.player.basic_info.name, 'base64').toString('utf8'),
            },
            {
                player_id: run.npc_id,
                player_camp: 2,
                dungeon_id: state.multiCampaign.dungeon_id,
                attr: run.enemy_attributes,
                name: tables.find('world_spawner', duel.worldSpawnerId)?.name ?? '',
            },
        ],
    }
}

export function npcArenaAppearances(state) {
    const run = state.combat.npcDuel
    const obj = (uuid, type, level, data) => ({
        agent_uid: uuid,
        // FO_Bot_Hero is not in ArenaManager.m_EntityDict. Agent7's
        // generic UUID removal handles its lifetime on same-scene retries.
        agent_type: type === 23 ? 7 : 4,
        lv: level,
        obj: {
            obj_id: Number(BigInt(uuid) & 0xffffffffn),
            obj_type: type,
            obj_data: [{ obj_index: 0, cli_battle_data: data }],
        },
    })
    const npc = obj(String(run.npc_id), 23, run.enemy_attributes.hero_info.hero_lv, {
        unit_id: String(run.npc_id),
        fobj_base_data: { hp: 1, sp: 0, move_info: run.positions.enemy },
    })
    return {
        obj: [
            npc,
            ...Object.values(run.actors).map((actor) =>
                obj(actor.uuid, 20, actor.level, {
                    unit_id: actor.uuid,
                    fobj_base_data: {
                        hp: state.combat.entities[actor.uuid]?.hp ?? actor.max_hp,
                        sp: state.combat.entities[actor.uuid]?.sp ?? 0,
                        move_info: run.in_fight[actor.uuid]?.move ?? { pos: actor.pos, angle: actor.angle },
                    },
                    pet_base_data: {
                        source_pet_guid: actor.source_guid,
                        in_fight: !!run.in_fight[actor.uuid],
                        skin_id: 0,
                    },
                }),
            ),
        ],
    }
}

// All runtime edits replace only small combat branches, preserving rollback
// isolation under Game.forkFastCombat and avoiding full account copies.
export function setArenaInFight(c, actor, move, inFight, first = false) {
    c = arenaContext(c)
    const battle = combatState(c.state, c.now)
    if (inFight)
        ensure(
            arenaSummonPositionAllowed(c.tables, battle.npcDuel.duel_id, actor, move.pos),
            'Arena summon position outside permitted deployment area',
        )
    advanceArenaScores(c)
    advanceArenaSp(c)
    const previous = battle.npcDuel
    const run = { ...previous, in_fight: { ...previous.in_fight } }
    run.entry_reports = { ...previous.entry_reports }
    run.arena_casts = { ...previous.arena_casts }
    delete run.entry_reports[actor.uuid]
    delete run.arena_casts[actor.uuid]
    if (inFight) {
        run.in_fight[actor.uuid] = {
            move,
            first,
            entered_at: arenaActionMillis(c) / 1000,
            ...(previous.pause ? { entered_report_at: c.now } : {}),
        }
        run.ever_summoned = { ...run.ever_summoned, [actor.uuid]: true }
    } else delete run.in_fight[actor.uuid]
    battle.npcDuel = inFight ? recordNoviceNpcDeployment(c.tables, run, actor) : run
    if (!inFight) clearArenaCardControls(c, actor.uuid)
    c.pushBefore('SCProtoKiboInFightChange', {
        changes: [{ kibo_guid: actor.uuid, in_fight: inFight, pos: move.pos, angle: move.angle, is_first: first }],
    })
}

export function syncNpcArenaEntities(c, selfAttributes) {
    c = arenaContext(c)
    const initial = initializeNpcDuelBattle(c.tables, c.state, selfAttributes, c.now)
    // Rebuilt client entities have no path/skill handlers from the old
    // connection. Retain SP/CDs, but wait for their new entry reports.
    const run = {
        ...initial,
        // These entities are created again from the newly sent arena payload.
        trainer_grade:
            selfAttributes.hero_info.hero_guid === initial.trainer_guid
                ? selfAttributes.hero_info.hero_grade
                : undefined,
        actors: Object.fromEntries(
            Object.entries(initial.actors).map(([id, actor]) => [
                id,
                {
                    ...actor,
                    native_owner: { status: 'known', guid: '0', kind: 'none', via: 'arena-roster' },
                },
            ]),
        ),
        require_entry_report: true,
        entry_reports: {},
        arena_casts: {},
        arena_cast_receipts: {},
        control_replay_done: false,
        control_replays: {},
        energy_sent: undefined,
        cost_stage_sent: undefined,
        stage_buffs_sent: undefined,
        fever_sent: undefined,
        hand_sent: undefined,
        pet_ai: Object.fromEntries(
            Object.entries(initial.pet_ai ?? {}).map(([uuid, ai]) => [uuid, { ...ai, moving: false }]),
        ),
    }
    c.state.combat.npcDuel = run
    resetArenaOrigins(c)
    const players = npcArenaPlayers(c.state, selfAttributes, c.tables)
    c.pushBefore('CSProtoKiboDuelArenaPlayerBaseInfo', {
        infos: players.player_info.map((player) => ({
            player_id: player.player_id,
            player_camp: player.player_camp,
            name: player.name,
            hero_guid: player.attr.hero_info.hero_guid,
            hero_conf_id: player.attr.hero_info.hero_conf_id ?? 0,
        })),
    })
    c.pushBefore('SCProtoKiboDuelPVPAllInfoSync', players)
    //11802 is keyed by player ID, including the NPC. The enemy roster alone
    // does not populate KiboArenaStore.firstPickInfo or the selection UI.
    const enemyFirst = Object.values(run.actors).find((actor) => actor.camp === 2)
    ensure(enemyFirst, 'No NPC first arena pet')
    c.pushBefore('SCProtoKiboDuelArenaFirstInfoSync', { id: run.npc_id, pet_guid: enemyFirst.source_guid })
    c.pushBefore('SCProtoBatchObjAppearNtf', npcArenaAppearances(c.state))
    for (const uuid of Object.keys(run.actors))
        c.pushBefore('SCProtoControlChangeByAddNtf', { agent_uid: uuid, cli_data: { uuid } })
}

// TryReportPlayerLoadFinish sends9602 after both rosters' entities are ready.
// 9604 is a separate UI callback and cannot be the prerequisite for FIRST.
export function reportNpcArenaLoadFinish(c) {
    c = arenaContext(c)
    const info = c.state.multiCampaign
    ensure(
        [2, 3, 4, 5, 6, 7].includes(info?.arena_status) && c.state.world.map_id === info.map_id,
        'No active arena loading',
    )
    ensure(c.state.combat?.npcDuel?.entities_sent, 'Arena entities have not been published')
    const wasLoaded = c.state.kiboDuelLoadingCompleteAt !== undefined
    c.state.kiboDuelLoadingCompleteAt ??= c.now
    if (!wasLoaded) publishArenaControls(c)
    publishArenaStatistics(c, true)
    publishArenaSp(c, true)
    const run = c.state.combat.npcDuel
    if (run.result) {
        // Relogin reloads actors even when this match has already settled.
        // Re-send its receipt before the exit stage, never reopen FIRST or
        // grant rewards again. Only an explicit restart creates a new match.
        c.pushBefore('SCProtoKiboDuelArenaScoreInfoSync', {
            score_infos: [1, 2].map((camp) => ({ camp, score: run.scores[camp] })),
        })
        c.pushBefore('SCProtoKiboDuelArenaResultInfoSync', run.result)
        c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
            status: info.arena_status,
            status_endtime: String(Math.ceil(run.exit_at ?? c.now)),
            enter_type: 0,
        })
        return
    }
    if (info.arena_status === 6) {
        if (!wasLoaded) beginNpcArenaPresentation(c, true)
        else publishNpcArenaPresentation(c)
        return
    }
    if (info.arena_status === 2) {
        const seconds = Number(
            c.tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_FIRST_KIBO_TIME')?.value,
        )
        ensure(Number.isFinite(seconds) && seconds > 0, 'Arena first selection time unavailable', ErrorCode.GameConfig)
        info.arena_status = 3
        c.state.combat.npcDuel = { ...c.state.combat.npcDuel, first_until: c.now + seconds }
        c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
            status: 3,
            status_endtime: String(Math.ceil(c.now + seconds)),
            enter_type: 0,
        })
    } else if (!wasLoaded && [3, 4].includes(info.arena_status)) {
        if (info.arena_status === 4) {
            c.pushBefore('SCProtoKiboDuelArenaScoreInfoSync', {
                score_infos: [1, 2].map((camp) => ({ camp, score: run.scores[camp] })),
            })
            c.pushBefore('SCProtoKiboDuelArenaCardInfoSync', arenaHand(c.state))
            publishArenaEnergy(c)
        }
        // Login status arrives before native HasReportedPlayerLoadFinish.
        // CheckEnter is event-driven: repeat the same canonical status after
        // 9602, including when pause prevents every subsequent battle tick.
        c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
            status: info.arena_status,
            status_endtime: String(Math.ceil(info.arena_status === 3 ? run.first_until : run.end_at)),
            enter_type: 0,
            ...arenaFeverInfo(c),
        })
    }
    if (c.state.world.pause?.operate) updateNpcArenaPause(c, c.state.world.pause)
    publishArenaCostStage(c)
    publishArenaStageBuffs(c)
}

export function startNpcArenaRound(c) {
    c = arenaContext(c)
    const info = c.state.multiCampaign,
        run = c.state.combat?.npcDuel
    if ([4, 6].includes(info?.arena_status) && c.state.kiboDuelFirstConfirmedAt) return
    ensure(info?.arena_status === 3 && c.state.kiboDuelLoadingCompleteAt, 'Arena first pet is not loaded')
    const first = Object.values(run.actors).find(
        (actor) => actor.camp === 1 && actor.source_guid === c.state.kiboDuelFirstGuid,
    )
    ensure(first, 'No first arena pet selected')
    ensure(
        Object.values(run.actors).some((actor) => actor.camp === 2),
        'No NPC first arena pet',
    )
    // StoryStage resolves the already-created roster by source GUID and uses
    // KiboPerformance visibility. Entering battle here would create the native
    // FloatingBarSystem and run summon triggers before the movie finishes.
    c.state.kiboDuelFirstConfirmedAt = c.now
    beginNpcArenaPresentation(c)
}

export function finishNpcArenaPresentation(c) {
    c = arenaContext(c)
    const info = c.state.multiCampaign,
        run = c.state.combat.npcDuel
    ensure(info.arena_status === 6 && c.now >= run.intro_until, 'Arena entry presentation is not complete')
    const first = Object.values(run.actors).find(
            (actor) => actor.camp === 1 && actor.source_guid === c.state.kiboDuelFirstGuid,
        ),
        enemyFirst = Object.values(run.actors).find((actor) => actor.camp === 2)
    ensure(first && enemyFirst, 'Arena first pet configuration unavailable', ErrorCode.GameConfig)
    startArenaClock(c)
    c.state.combat.npcDuel = { ...c.state.combat.npcDuel, intro_completed_at: c.now }
    info.arena_status = 4
    if (!run.active_task_join_recorded) {
        recordActiveProgress(c.tables, c.state, 15071, 1, c.now)
        c.state.combat.npcDuel = { ...c.state.combat.npcDuel, active_task_join_recorded: true }
        notifyActive(c)
    }
    // Preserve already-deployed first pets from a saved pre-fix introduction.
    if (!run.in_fight[first.uuid]) setArenaInFight(c, first, run.positions.selfSummon, true, true)
    if (!run.in_fight[enemyFirst.uuid]) setArenaInFight(c, enemyFirst, run.positions.enemySummon, true, true)
    c.pushBefore('SCProtoKiboDuelArenaScoreInfoSync', {
        score_infos: [1, 2].map((camp) => ({ camp, score: run.scores[camp] })),
    })
    c.pushBefore('SCProtoKiboDuelArenaCardInfoSync', arenaHand(c.state))
    publishArenaEnergy(c)
    c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
        status: 4,
        status_endtime: String(Math.ceil(c.state.combat.npcDuel.end_at)),
        enter_type: 0,
    })
}

export function registerNpcArenaSummons(on) {
    const summon = (camp) => (c, r) => {
        c = arenaContext(c)
        let run = c.state.combat?.npcDuel
        const retired = c.state.retiredNpcArenaActors?.[String(r.pet_guid ?? '0')]
        if (retired?.camp === camp && (camp === 2 || retired.source_guid === String(r.source_pet_guid))) return {}
        const finishedActor = run?.result && run.actors[String(r.pet_guid ?? '0')]
        if (finishedActor?.camp === camp && (camp === 2 || finishedActor.source_guid === String(r.source_pet_guid)))
            return {}
        ensure(
            run && run.map_id === c.state.world.map_id && c.state.multiCampaign?.arena_status === 4,
            'NPC arena battle is not running',
        )
        const actor = run.actors[String(r.pet_guid ?? '0')]
        ensure(actor?.camp === camp, 'Summon actor is not in this arena camp')
        if (camp === 1) ensure(String(r.source_pet_guid ?? '0') === actor.source_guid, 'Arena summon source mismatch')
        ensure(
            r.pos && ['x', 'y', 'z'].every((key) => Number.isInteger(r.pos[key]) && Math.abs(r.pos[key]) <= 100000000),
            'Invalid arena summon position',
        )
        ensure(Number.isInteger(r.angle ?? 0), 'Invalid arena summon angle')
        ensure(
            arenaSummonPositionAllowed(c.tables, run.duel_id, actor, r.pos),
            'Arena summon position outside permitted deployment area',
        )
        const replacement = String(r.replace_kibo_guid ?? '0')
        ensure(replacement !== actor.uuid, 'Cannot replace an arena pet with itself')
        if (replacement !== '0')
            ensure(
                run.actors[replacement]?.camp === camp && run.in_fight[replacement],
                'Arena replacement is not fighting',
            )
        if (run.in_fight[actor.uuid]) return {}
        const limit = c.tables.find('kibo_duel', run.duel_id).KiboNumber
        ensure(
            Object.keys(run.in_fight).filter((id) => run.actors[id].camp === camp).length -
                (replacement !== '0' ? 1 : 0) <
                limit,
            'Arena field is full',
        )
        ensure(c.state.combat.entities[actor.uuid]?.hp > 0, 'Arena pet is defeated')
        const move = { pos: { ...r.pos }, angle: (((r.angle ?? 0) % 360) + 360) % 360 }
        advanceArenaScores(c)
        if (c.state.combat.npcDuel.scores[1] <= 0 || c.state.combat.npcDuel.scores[2] <= 0) return {}
        advanceArenaEnergy(c)
        run = c.state.combat.npcDuel
        if (camp === 2 && (run.energy[2].points < 100 - 1e-7 || arenaMillis(c) < (run.gcd_until[2] ?? 0))) {
            c.state.combat.npcDuel = {
                ...run,
                npc_queue: { ...run.npc_queue, [actor.uuid]: { ...r, pos: { ...r.pos } } },
            }
            return {}
        }
        consumeArenaPoint(c, camp)
        if (replacement !== '0') setArenaInFight(c, run.actors[replacement], run.in_fight[replacement].move, false)
        setArenaInFight(c, actor, move, true)
        c.pushBefore('SCProtoKiboDuelArenaCardInfoSync', arenaHand(c.state))
        publishArenaEnergy(c)
        return {}
    }
    on('KiboDuelArenaSummonReq', summon(1))
    on('PVEEnemySummonReq', summon(2))
    on('KiboDuelPlaySummonActionFinish', (c, r) => {
        c = arenaContext(c)
        const run = c.state.combat?.npcDuel,
            uuid = String(r.uuid ?? '0')
        ensure(
            run &&
                (uuid === String(run.npc_id) ||
                    run.actors[uuid] ||
                    uuid === c.state.kiboDuelGroups?.[c.state.multiCampaign?.formation_slot]?.hero),
            'Unknown arena summon animation actor',
        )
        c.state.combat.npcDuel = { ...run, summon_actions: { ...run.summon_actions, [uuid]: c.now } }
    })
    on('ControlMapAI', (c, r) => {
        c = arenaContext(c)
        const run = c.state.combat?.npcDuel
        ensure(run && run.map_id === c.state.world.map_id, 'No active NPC arena')
        ensure([0, 1, 2].includes(r.control_type ?? 0) && [1, 2].includes(r.status), 'Invalid arena AI control')
        c.state.combat.npcDuel = { ...run, ai_control: { ...run.ai_control, [r.control_type ?? 0]: r.status } }
        if (r.status === 1 && (r.control_type ?? 0) !== 1) stopArenaPetAI(c)
        return {}
    })
    on('KiboDuelArenaAutoFightSync', (c, r) => {
        c = arenaContext(c)
        const run = c.state.combat?.npcDuel
        // The UI also sends its stop notification while tearing down a duel.
        if (!run && r.status === 2) return
        ensure(run && [1, 2].includes(r.status), 'Invalid arena automatic battle state')
        const duel = c.tables.find('kibo_duel', run.duel_id)
        if (r.status === 1) {
            const parts = String(duel.autoCondition || '')
                .split('|')
                .filter(Boolean)
                .map(Number)
            ensure(
                duel.isAuto === 1 &&
                    (!parts.length ||
                        (parts.length === 3 &&
                            parts[0] === 12100 &&
                            (c.state.kiboDuelAreas?.[parts[1]]?.lvl ?? 1) >= parts[2])),
                'Arena automatic battle is locked',
            )
        }
        c.state.combat.npcDuel = { ...run, auto_fight: r.status === 1 }
    })
    on('KiboCastUltraSkill', (c, r) => {
        c = arenaContext(c)
        const run = c.state.combat?.npcDuel
        const guid = String(r.guid)
        if (c.state.retiredNpcArenaActors?.[guid]) return
        ensure(run?.map_id === c.state.world.map_id, 'No active NPC arena')
        const actor = Object.values(run?.actors ?? {}).find((actor) => [actor.uuid, actor.source_guid].includes(guid))
        //11875 reports the entry cast attempt's result, not an auto-ultimate
        // preference. A false report must not disable later full-energy casts.
        ensure(actor, 'Arena entry skill actor is not in this duel')
        if (run.result) return
        c.state.combat.npcDuel = {
            ...run,
            ultra_choices: { ...run.ultra_choices, [actor.source_guid]: !!r.cast_ultra_skill },
            entry_reports: {
                ...run.entry_reports,
                ...(run.in_fight[actor.uuid]
                    ? {
                          [actor.uuid]: {
                              cast: !!r.cast_ultra_skill,
                              consumed:
                                  run.arena_casts?.[actor.uuid]?.origin === 'client' &&
                                  run.arena_casts[actor.uuid].slot === 206,
                          },
                      }
                    : {}),
            },
        }
    })
}

export function retireNpcArenaActors(state) {
    const run = state.combat?.npcDuel
    if (!run) return
    const entries = { ...state.retiredNpcArenaActors }
    for (const actor of Object.values(run.actors))
        entries[actor.uuid] = { camp: actor.camp, source_guid: actor.source_guid }
    state.retiredNpcArenaActors = Object.fromEntries(Object.entries(entries).slice(-64))
}

export function recordNpcArenaMovement(c, item) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run?.actors[item.uuid]) return false
    if (!run.in_fight[item.uuid]) return true
    const move = item.info
    ensure(
        move?.pos &&
            ['x', 'y', 'z'].every((key) => Number.isInteger(move.pos[key]) && Math.abs(move.pos[key]) < 100000000),
        'Invalid arena movement',
    )
    c.state.combat = {
        ...c.state.combat,
        npcDuel: {
            ...run,
            in_fight: {
                ...run.in_fight,
                [item.uuid]: { ...run.in_fight[item.uuid], move: { ...move, pos: { ...move.pos } } },
            },
        },
    }
    return true
}

export function processNpcArenaQueue(c) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run?.npc_queue || run.pause || c.state.multiCampaign?.arena_status !== 4) return
    const entries = Object.entries(run.npc_queue)
    if (!entries.length) return
    const [uuid, request] = entries[0],
        actor = run.actors[uuid]
    if (!actor || c.state.combat.entities[uuid]?.hp === 0 || run.in_fight[uuid]) {
        const queue = { ...run.npc_queue }
        delete queue[uuid]
        c.state.combat.npcDuel = { ...run, npc_queue: queue }
        return
    }
    if (!arenaSummonPositionAllowed(c.tables, run.duel_id, actor, request.pos)) {
        const queue = { ...run.npc_queue }
        delete queue[uuid]
        c.state.combat.npcDuel = { ...run, npc_queue: queue }
        console.warn(`[npc-arena] Discarded queued summon outside deployment area: ${uuid}`)
        return
    }
    const active = Object.keys(run.in_fight).filter((id) => run.actors[id].camp === 2).length
    if (
        active >= c.tables.find('kibo_duel', run.duel_id).KiboNumber ||
        run.energy[2].points < 100 - 1e-7 ||
        arenaMillis(c) < run.gcd_until[2]
    )
        return
    consumeArenaPoint(c, 2)
    const queue = { ...c.state.combat.npcDuel.npc_queue }
    delete queue[uuid]
    c.state.combat.npcDuel = { ...c.state.combat.npcDuel, npc_queue: queue }
    setArenaInFight(c, actor, { pos: request.pos, angle: (((request.angle ?? 0) % 360) + 360) % 360 }, true)
}

export function recordNpcArenaDeaths(c) {
    c = arenaContext(c)
    advanceArenaScores(c)
    const battle = c.state.combat,
        previous = battle?.npcDuel
    if (!previous || previous.map_id !== c.state.world.map_id || c.state.multiCampaign?.arena_status !== 4) return false
    // Scores already terminated, or the real timeout precedes this late HP report.
    if (arenaScoreOutcome(previous) || c.now >= previous.end_at) return false
    const died = Object.keys(previous.in_fight).filter(
        (uuid) => battle.entities[uuid]?.hp === 0 && !Object.hasOwn(previous.dead, uuid),
    )
    if (!died.length) return false
    const penalty = Number(c.tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_DEAD_SCORE')?.value)
    ensure(
        Number.isInteger(penalty) && penalty > 0,
        'Arena death score configuration unavailable',
        ErrorCode.GameConfig,
    )
    const run = {
        ...previous,
        in_fight: { ...previous.in_fight },
        dead: { ...previous.dead },
        scores: { ...previous.scores },
    }
    for (const uuid of died) {
        run.dead[uuid] = c.now
        delete run.in_fight[uuid]
        const camp = run.actors[uuid].camp
        run.scores[camp] = Math.max(0, run.scores[camp] - penalty)
    }
    // OnKiboDead already removes the local fighting slot; do not send an
    // out-of-fight teleport before the client's death animation has run.
    battle.npcDuel = sealArenaScoreOutcome(run, arenaMillis(c), run.scores, 'death')
    c.push('SCProtoKiboDuelArenaScoreInfoSync', {
        score_infos: [1, 2].map((camp) => ({ camp, score: run.scores[camp] })),
    })
    return true
}
