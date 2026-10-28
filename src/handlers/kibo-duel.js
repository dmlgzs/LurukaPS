import { ErrorCode } from '../error-codes.js'
import { registerNpcArenaResults } from '../npc-kibo-result.js'
import { duelProgressSnapshot } from '../kibo-duel-progress.js'
import { KIBO_LOCKED_SLOT, duelPresetSnapshotGroups, registerDuelPresetEditing } from '../kibo-duel-presets.js'
import { clearArenaStageBuffs } from '../npc-kibo-stage-buffs.js'
import {
    initializeNpcDuelBattle,
    arenaPoint,
    syncNpcArenaEntities,
    registerNpcArenaSummons,
    setArenaInFight,
    startNpcArenaRound,
    retireNpcArenaActors,
} from '../npc-kibo-battle.js'
import { arenaPetAttributes } from '../kibo-arena-attributes.js'
import { selectedArenaGroup, validateNpcDuelFormation, npcDuelEntry } from '../npc-kibo-duel.js'
import { ensure } from './common.js'
import { rememberMap, worldSync } from './world.js'
import { heroModules, syncBattle } from '../battle.js'
import {
    arenaTrainer,
    prepareArenaTrainer,
    clearArenaTrialTrainer,
    expireArenaTrialTrainer,
} from '../npc-kibo-trainer.js'
import { trialPayload } from './trial-groups.js'
import { petData, petGrade } from '../pets.js'
import { ensureEntrustSceneObjects } from '../entrust.js'
import { storyCampaignSnapshot } from '../story-campaign.js'
import { syncStoryCampaignEnemies } from './story-campaign.js'
import { exitEntrust, syncEntrust, startMaterialDungeon, restartMaterialDungeon } from './entrust.js'
import { acknowledgeAbyssSceneLoaded } from '../abyss-scene.js'

const ids = (text) =>
    String(text ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
const duelSkills = (row) =>
    ids(row.skillList).map((skill_id, i) => ({ skill_id, skill_lv: 1, skill_slot: 701 + i, type: 1 }))
export const lockedDuelSlot = KIBO_LOCKED_SLOT
const arenaLockedSlot = 0
// CBT3 ClientReadyTask.OnStart reports9596 after the arena scene loads.
// 9509 is used by other dungeon flows and is not sent by this NPC route.
// Keep both callbacks idempotent;9602 still waits for all pet entities.
export function syncLoadedNpcArena(c) {
    const info = c.state.multiCampaign
    if (!info || info.map_id !== c.state.world.map_id || !c.state.combat?.npcDuel) return
    if (c.state.combat.npcDuel.entities_sent) return
    info.status = 3
    const { duel_id, arena_status, formation_slot, ...wire } = info
    c.pushBefore('CSProtoCurMultiCampaignInfoSync', wire)
    // OnlineModeChange targets the current SceneProxy. The earlier packet
    // before the scene cut targets the old proxy; the new proxy starts in
    // Default mode and rejects batch AOI until mode9 is applied after9596.
    c.pushBefore('CSProtoOnlineModeChange', { mode: 9 })
    syncNpcArenaEntities(c, arenaAttributePayload(c.tables, c.state))
    c.state.combat.npcDuel = { ...c.state.combat.npcDuel, entities_sent: true }
}
function arenaPetGuid(state, entry) {
    const id = String(entry.id ?? '0')
    if (id === '0') return '0'
    return entry.is_trial ? ((9n << 56n) | (BigInt(id) << 32n) | BigInt(state.player.basic_info.id)).toString() : id
}
function normalizeArenaPets(state, entries) {
    return entries.map((entry) => ({
        guid: arenaPetGuid(state, entry),
        is_trial: !!entry.is_trial,
        id: String(entry.id ?? '0'),
    }))
}
export function repairPendingDuelEntry(state, now = Math.floor(Date.now() / 1000), tables) {
    expireArenaTrialTrainer(state)
    const info = state.multiCampaign
    if (!info || state.world.map_id !== info.map_id) return false
    const run = state.combat?.npcDuel
    if (
        run?.version === 1 &&
        info.arena_status &&
        run.start_time === info.start_time &&
        run.map_id === info.map_id &&
        (info.arena_status !== 4 || run.energy)
    ) {
        if (run.result) return false
        // Re-enter through the original NPC preparation UI after login. The
        // original Lua page keeps its own level cache and guide FSM; a server
        // runtime snapshot cannot initialize either on a cold in-arena login.
        if (tables) npcDuelEntry(tables, info.duel_id)
        return leaveSavedNpcArena(state)
    }
    if (
        info.status === 2 &&
        info.arena_status &&
        (!Number.isFinite(Number(now)) || Number(now) - Number(info.start_time) < 60)
    )
        return false
    return leaveSavedNpcArena(state)
}
function leaveSavedNpcArena(state) {
    const previous = state.worldHistory?.pop()
    if (!previous) return false
    Object.assign(state.world, previous)
    retireNpcArenaActors(state)
    delete state.world.pause
    delete state.multiCampaign
    delete state.combat
    clearArenaTrialTrainer(state)
    delete state.kiboDuelLoadingCompleteAt
    delete state.kiboDuelFirstGuid
    delete state.kiboDuelFirstConfirmedAt
    return true
}
export function ensureArenaFormationManager(state) {
    const managers = (state.player.group_mgrs ??= [])
    let arena = managers.find((m) => m.type === 6)
    if (!arena) {
        arena = { type: 6, cur_group: 1, last_group: 1, src: 0, groups: [] }
        managers.push(arena)
    }
    arena.groups ??= []
    if (arena.cur_group == null) arena.cur_group = 1
    return arena
}
export function kiboDuelSnapshot(state, tables) {
    return {
        use_slot: state.kiboDuelSlot ?? 1,
        groups: tables ? duelPresetSnapshotGroups(tables, state) : Object.values(state.kiboDuelGroups ?? {}),
        records: Object.values(state.kiboDuelRecords ?? {}),
        ...(tables ? duelProgressSnapshot(tables, state) : { area_infos: Object.values(state.kiboDuelAreas ?? {}) }),
    }
}
function lockedFormation(tables, state, row) {
    const trialIds = ids(row.kiboList)
    ensure(
        trialIds.every((id) => tables.find('trial_pet', id)),
        'Kibo duel trial pet unavailable',
        ErrorCode.TrialPetNotExist,
    )
    const selected = trialIds.map((id) => ({ is_trial: true, id: String(id) }))
    const usedConfigs = new Set(trialIds.map((id) => tables.find('trial_pet', id).trialPet))
    for (const configId of ids(row.kiboLockList)) {
        if (selected.length >= 8) break
        if (usedConfigs.has(configId)) continue
        const pet = state.pets.find((p) => Number(p.config_id) === configId)
        if (!pet) continue
        selected.push({ is_trial: false, id: String(pet.guid) })
        usedConfigs.add(configId)
    }
    while (selected.length < 8) selected.push({ is_trial: false, id: '0' })
    const heroConfig = Number(
        tables
            .get('game')
            .find(
                (g) =>
                    g.title === (state.player.basic_info.sex === 1 ? 'AVATAR_HERO_ID_MALE' : 'AVATAR_HERO_ID_FEMALE'),
            )?.value,
    )
    const hero = row.trialRole
        ? String(arenaTrainer(tables, state, row).conf_id)
        : (state.player.heros_info.heros.find((h) => h.conf_id === heroConfig)?.guid ?? '0')
    const hero_skills = duelSkills(row)
    return {
        slot: lockedDuelSlot,
        pet_guids: normalizeArenaPets(state, selected),
        hero,
        hero_skills,
        duel_id: row.id,
        index: Number(row.kiboLock) || 0,
    }
}
export function arenaAttributePayload(tables, state) {
    const group = selectedArenaGroup(state) ?? state.kiboDuelGroups?.[arenaLockedSlot]
    ensure(group?.pet_guids?.length === 8, 'Arena formation unavailable')
    const duel = tables.find('kibo_duel', state.multiCampaign?.duel_id ?? group.duel_id)
    const hero = arenaTrainer(tables, state, duel, group)
    const heroBase = heroModules(tables, state, hero),
        infos = []
    for (const entry of group.pet_guids) {
        if (entry.id === '0') continue
        let profile
        if (entry.is_trial) {
            const trial = tables.find('trial_pet', Number(entry.id))
            ensure(trial, 'Trial pet configuration unavailable', ErrorCode.TrialPetNotExist)
            const source =
                state.pets.find((p) => p.config_id === trial.trialPet) ?? state.kiboDuelTrialProfiles?.[entry.id]
            ensure(source, 'Trial pet profile unavailable', ErrorCode.PetNotExist)
            profile = { ...source, guid: entry.guid, config_id: trial.trialPet, lv: trial.trialPetLevel, hero_id: '0' }
        } else profile = state.pets.find((p) => p.guid === entry.id)
        ensure(profile, 'Arena pet unavailable')
        const attributes = arenaPetAttributes(tables, profile.config_id, profile.lv)
        infos.push({
            pet_guid: entry,
            attrs: attributes.attrs,
            skills: attributes.skills,
            pet_conf_id: profile.config_id,
            pet_lv: profile.lv,
            pet_color: profile.color ?? 0,
            special: profile.special ?? 0,
            gene_list: (profile.gene_infos ?? []).map((g) => g.gene_id),
        })
    }
    return {
        infos,
        hero_info: {
            hero_guid: hero.guid,
            hero_conf_id: hero.conf_id,
            hero_lv: hero.hero_lv,
            hero_star: hero.hero_star,
            hero_grade: hero.hero_grade,
            attrs: heroBase.modules[0].sub_modules[0].attrs,
            skills: group.hero_skills ?? [],
        },
    }
}
function saveArenaGroup(arena, protocol, group) {
    const serialized = protocol.encode('cs.PetDuelGroupInfo', group).toString('base64')
    const saved = arena.groups.find((g) => g.id === group.slot)
    if (saved) saved.pet_duel_group_info = serialized
    else arena.groups.push({ id: group.slot, heros: [], control: '0', pet_duel_group_info: serialized })
}
export function registerKiboDuel(on, tables, protocol) {
    registerDuelPresetEditing(on, tables, kiboDuelSnapshot)
    registerNpcArenaSummons(on)
    registerNpcArenaResults(on, tables)
    const prepare = (c, r) => {
        const row = tables.find('kibo_duel', r.u32)
        ensure(row, 'Unknown Kibo duel')
        for (const id of ids(row.kiboList)) {
            const trial = tables.find('trial_pet', id)
            ensure(trial, 'Trial pet configuration unavailable', ErrorCode.TrialPetNotExist)
            if (c.state.pets.some((p) => p.config_id === trial.trialPet) || c.state.kiboDuelTrialProfiles?.[id])
                continue
            const profile = petData(
                tables,
                trial.trialPet,
                arenaPetGuid(c.state, { is_trial: true, id }),
                0,
                undefined,
                undefined,
                { temporary: true },
            )
            profile.lv = trial.trialPetLevel
            profile.grade = petGrade(tables, profile)
            ;(c.state.kiboDuelTrialProfiles ??= {})[id] = profile
        }
        const arena = ensureArenaFormationManager(c.state),
            groups = (c.state.kiboDuelGroups ??= {})
        let group = groups[lockedDuelSlot]
        if (!group || group.duel_id !== row.id || group.pet_guids?.length !== 8 || row.levelType === 2)
            group = lockedFormation(tables, c.state, row)
        else if (!group.hero_skills?.length && row.skillList) group = { ...group, hero_skills: duelSkills(row) }
        group = { ...group, pet_guids: normalizeArenaPets(c.state, group.pet_guids) }
        groups[lockedDuelSlot] = group
        // CBT3's native KiBoDuelStore uses 98; the arena Lua page uses 0.
        let arenaGroup =
            groups[arenaLockedSlot]?.duel_id === row.id && groups[arenaLockedSlot].pet_guids?.length === 8
                ? groups[arenaLockedSlot]
                : { ...group, slot: arenaLockedSlot }
        if (row.levelType === 2) arenaGroup = { ...group, slot: arenaLockedSlot }
        if (!arenaGroup.hero_skills?.length && row.skillList)
            arenaGroup = { ...arenaGroup, hero_skills: duelSkills(row) }
        arenaGroup = { ...arenaGroup, pet_guids: normalizeArenaPets(c.state, arenaGroup.pet_guids) }
        groups[arenaLockedSlot] = arenaGroup
        const presetCount = Number(
            tables.get('game').find((row) => row.title === 'KIBO_DUEL_FORMATION_NUM_LIMIT')?.value,
        )
        ensure(
            Number.isInteger(presetCount) && presetCount > 0,
            'Kibo preset count is unavailable',
            ErrorCode.GameConfig,
        )
        if (
            !Number.isInteger(c.state.kiboDuelSlot) ||
            !(
                (c.state.kiboDuelSlot >= 1 && c.state.kiboDuelSlot <= presetCount) ||
                c.state.kiboDuelSlot === lockedDuelSlot
            )
        )
            c.state.kiboDuelSlot = 1
        saveArenaGroup(arena, protocol, arenaGroup)
        saveArenaGroup(arena, protocol, group)
        // Arena (type 6) lives in PlayerData; 10740 only populates KiBoDuelStore.
        c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [arena] })
        c.pushBefore('CSProtoKiboDuelGroupInfoSync', kiboDuelSnapshot(c.state, tables))
        return {}
    }
    on('KiboDuelGetGroup', prepare)
    on('KiboDuelGroupChange', (c, r) => {
        ensure(r.type === 6 && r.group, 'Invalid arena group type')
        const slot = Number(r.group.slot ?? 0)
        ensure(
            Number.isInteger(slot) && (slot === arenaLockedSlot || slot === lockedDuelSlot || (slot >= 1 && slot <= 5)),
            'Invalid arena group slot',
        )
        ensure(Array.isArray(r.group.pet_guids) && r.group.pet_guids.length === 8, 'Invalid arena pet slots')
        const row = tables.find('kibo_duel', r.group.duel_id)
        ensure(row, 'Unknown Kibo duel')
        const pet_guids = r.group.pet_guids.map((p) => {
            const id = String(p.id ?? '0'),
                is_trial = !!p.is_trial
            if (id !== '0')
                ensure(
                    is_trial ? !!tables.find('trial_pet', Number(id)) : c.state.pets.some((pet) => pet.guid === id),
                    'Invalid arena pet',
                )
            return { is_trial, id }
        })
        const existing = c.state.kiboDuelGroups?.[slot],
            hero = String(r.group.hero ?? existing?.hero ?? '0')
        const trialTrainer = row.trialRole ? arenaTrainer(tables, c.state, row) : null
        ensure(
            hero === '0' ||
                c.state.player.heros_info.heros.some((h) => h.guid === hero) ||
                (trialTrainer && [String(trialTrainer.conf_id), trialTrainer.guid].includes(hero)),
            'Arena hero not owned',
        )
        const hero_skills = r.group.hero_skills ?? []
        ensure(hero_skills.length <= 8, 'Invalid arena skills')
        const group = {
            slot,
            pet_guids: normalizeArenaPets(c.state, pet_guids),
            hero: trialTrainer ? String(trialTrainer.conf_id) : hero,
            hero_skills,
            duel_id: row.id,
            index: Number(r.group.index ?? existing?.index ?? 0),
        }
        const arena = ensureArenaFormationManager(c.state)
        saveArenaGroup(arena, protocol, group)
        ;(c.state.kiboDuelGroups ??= {})[slot] = group
        c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [arena] })
        return {}
    })
    on('SetKiboDuelCurGroup', (c, r) => {
        ensure(r.type === 6, 'Invalid arena group type')
        const slot = Number(r.cur_group ?? 0),
            arena = ensureArenaFormationManager(c.state)
        ensure(
            Number.isInteger(slot) && ((slot >= 1 && slot <= 5) || arena.groups.some((g) => g.id === slot)),
            'Unknown arena group',
        )
        arena.last_group = arena.cur_group
        arena.cur_group = slot
        c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [arena] })
        return {}
    })
    const createNpcArena = (c, r, restarting = false) => {
        const dungeon = tables.find('dungeon', r.dungeon_id),
            duel = dungeon && tables.find('kibo_duel', dungeon.gameplayID)
        ensure(
            dungeon?.dungeonType === 400 && duel?.dungeonId === dungeon.id,
            'Unsupported dungeon',
            ErrorCode.InvalidProtoID,
        )
        const map = tables.find('kibo_duel_map', duel.mapId),
            scene = Number(map?.art)
        ensure(
            Number.isInteger(scene) && scene > 0,
            'Invalid arena scene configuration',
            ErrorCode.KiboDuelConfArtMapNone,
        )
        npcDuelEntry(tables, duel.id)
        // SceneData.Init(KiboArenaMapMono) takes the blue trainer position.
        // The generic dungeon.position is reused across different arenas.
        const trainerSpawn = arenaPoint(tables, map, 'nestBorthPos1', 100)
        const arena = ensureArenaFormationManager(c.state),
            formation =
                duel.kiboLock || duel.levelType === 2
                    ? c.state.kiboDuelGroups?.[arenaLockedSlot]
                    : selectedArenaGroup(c.state)
        ensure(formation, 'Arena formation unavailable')
        if ([arenaLockedSlot, lockedDuelSlot].includes(formation.slot))
            ensure(formation.duel_id === duel.id, 'Locked formation belongs to another duel')
        validateNpcDuelFormation(tables, c.state, duel, formation)
        const petGuids = formation.pet_guids.filter((p) => p.id !== '0').map((p) => p.guid)
        ensure(petGuids.length >= Number(duel.minimumKibo), 'Not enough arena pets')
        const active = c.state.multiCampaign
        ensure(
            !active || (active.dungeon_id === dungeon.id && active.status >= 2 && active.status <= 3),
            'Another dungeon is active',
        )
        if (!active) {
            delete c.state.combat
            if (!restarting) rememberMap(c, scene)
            const w = c.state.world
            w.map_id = scene
            w.point_id = 0
            w.area_id = 0
            w.pos = { ...trainerSpawn.pos }
            w.angle = trainerSpawn.angle
            c.state.multiCampaign = {
                dungeon_id: dungeon.id,
                duel_id: duel.id,
                status: 2,
                start_time: String(c.now),
                dungeon_scene_id: scene,
                map_id: scene,
                line_id: 1,
                arena_status: 2,
                formation_slot: formation.slot,
            }
        }
        const { duel_id, arena_status, formation_slot, ...info } = c.state.multiCampaign
        const hero = prepareArenaTrainer(tables, c.state, duel, formation)
        if (!petGuids.includes(c.state.kiboDuelFirstGuid)) c.state.kiboDuelFirstGuid = petGuids[0]
        initializeNpcDuelBattle(tables, c.state, arenaAttributePayload(tables, c.state), c.now)
        c.state.combat.npcDuel = { ...c.state.combat.npcDuel, trainer_guid: hero.guid }
        if (duel.trialRole) {
            c.pushBefore('CSProtoTrialDatas', trialPayload(c.state))
            syncBattle({ ...c, push: c.pushBefore })
        }
        const name = Buffer.from(c.state.player.basic_info.name, 'base64').toString('utf8')
        c.pushBefore('CSProtoKiboDuelFightingInfoSync', { id: duel.id, status: 2, start_time: c.now })
        c.pushBefore('CSProtoMultiCampaignInfoSync', { camp: [info] })
        c.pushBefore('CSProtoCurMultiCampaignInfoSync', info)
        c.pushBefore('CSProtoMultiCampaignBaseInfoSync', {
            dungeon_id: dungeon.id,
            dungeon_scene_id: scene,
            player_list: [
                {
                    player_id: c.id,
                    hero_id: hero.conf_id,
                    name,
                    lv: c.state.player.basic_info.lv,
                    heros: [{ hero_id: hero.conf_id }],
                },
            ],
            team_option_list: [{ player_id: c.id, stay: true }],
            player_status_list: [{ player_id: c.id, status: 1 }],
        })
        c.pushBefore('CSProtoKiboDuelArenaPlayerBaseInfo', {
            infos: [{ player_id: c.id, name, player_camp: 1, hero_guid: hero.guid, hero_conf_id: hero.conf_id }],
        })
        c.pushBefore('SCProtoKiboDuelSingleInfoSync', {
            player_id: c.id,
            player_camp: 1,
            dungeon_id: dungeon.id,
            attr: arenaAttributePayload(tables, c.state),
            name,
        })
        c.pushBefore('CSProtoKiboDuelAttrInfoSync', arenaAttributePayload(tables, c.state))
        c.pushBefore('SCProtoKiboDuelArenaCardInfoSync', { pet_guids: petGuids })
        c.pushBefore('SCProtoKiboDuelArenaFirstInfoSync', { id: c.id, pet_guid: c.state.kiboDuelFirstGuid })
        if (!restarting) worldSync(c, {}, 256, false)
        const arenaInfo = { status_endtime: String(c.now + Number(duel.time || 300)), enter_type: 0 }
        c.push('CSProtoOnlineModeChange', { mode: 9 })
        c.push('SCProtoKiboDuelArenaInfoSync', { ...arenaInfo, status: c.state.multiCampaign.arena_status })
        return {}
    }
    on('MultiCampaignCreate', (c, r) => (r.scene_type === 12 ? startMaterialDungeon(c, r) : createNpcArena(c, r)))
    // The commission teaching panel directly sends10746, without opening
    // the arena formation page. Its configured dungeon is still type400;
    // publish the same native arena state, rather than a fabricated old win.
    on('KiboDuelStart', (c, r) => {
        const { duel } = npcDuelEntry(tables, r.u32)
        ensure(
            tables.get('train_task').some((row) => row.groupType === 3 && row.dungeonId === duel.id),
            'Not a configured duel teaching entry',
            ErrorCode.TrainTaskConfNone,
        )
        prepare(c, { u32: duel.id })
        return createNpcArena(c, { dungeon_id: duel.dungeonId })
    })
    const restart = (c) => {
        const run = c.state.combat?.npcDuel,
            campaign = c.state.multiCampaign
        ensure(run && campaign, 'No active NPC arena', ErrorCode.NotInMultiCampaign)
        ensure(
            run.map_id === c.state.world.map_id && campaign.map_id === c.state.world.map_id,
            'NPC arena restart scene is not active',
            ErrorCode.NotInDungeonMap,
        )
        if (campaign.arena_status === 2 && run.restart_of !== undefined) return
        ensure(run.result && tables.find('kibo_duel', run.duel_id)?.isRechallenge, 'NPC arena cannot restart yet')
        retireNpcArenaActors(c.state)
        const ids = [String(run.npc_id), ...Object.keys(run.actors)]
        for (const agent_uid of Object.keys(run.actors)) c.pushBefore('SCProtoControlChangeByDelNtf', { agent_uid })
        c.pushBefore('SCProtoBatchObjDisappearNtf', { obj: ids.map((agent_uid) => ({ agent_uid })) })
        const dungeon = campaign.dungeon_id
        delete c.state.multiCampaign
        delete c.state.combat
        delete c.state.kiboDuelLoadingCompleteAt
        delete c.state.kiboDuelFirstConfirmedAt
        const output = { ...c, pushBefore: c.push }
        createNpcArena(output, { dungeon_id: dungeon }, true)
        syncNpcArenaEntities(output, arenaAttributePayload(tables, c.state))
        c.state.combat.npcDuel = { ...c.state.combat.npcDuel, entities_sent: true, restart_of: run.generation }
    }
    on('MultiCampaignRestart', (c) => {
        if (['material', 'weekly'].includes(c.state.entrust?.run?.kind)) return restartMaterialDungeon(c)
        restart(c)
        return {}
    })
    on('ArenaRestartConfirm', (c, r) => {
        ensure([0, 1, 2].includes(r.op ?? 0), 'Invalid arena restart operation')
        if (r.op !== 2) restart(c)
        return { op: r.op === 2 ? 2 : 1, ret_code: ErrorCode.Succ }
    })
    on('StartDungeonClientOk', (c) => {
        if (c.state.abyssRun !== undefined) return acknowledgeAbyssSceneLoaded(tables, c.state)
        if (c.state.storyCampaign) {
            ensure(c.state.storyCampaign.map_id === c.state.world.map_id, 'Story dungeon scene is not active')
            c.state.storyCampaign.loading_complete_at ??= c.now
            c.pushBefore('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
            syncStoryCampaignEnemies(c)
            return {}
        }
        const entrust = c.state.entrust?.run
        if (entrust && [2, 3].includes(entrust.status)) {
            ensure(c.state.world.map_id === entrust.map_id, 'Entrust scene is not active')
            ensureEntrustSceneObjects(tables, c.state)
            entrust.loading_complete_at ??= c.now
            syncEntrust(c, entrust)
            return {}
        }
        const info = c.state.multiCampaign
        ensure(info?.status >= 2 && c.state.world.map_id === info.map_id, 'No active dungeon')
        syncLoadedNpcArena(c)
        return {}
    })
    on('MultiCampaignPlayerLoadingPageComplete', (c) => {
        if ([2, 3].includes(c.state.entrust?.run?.status) && c.state.entrust.run.map_id === c.state.world.map_id)
            return {}
        const info = c.state.multiCampaign
        ensure(
            [2, 3, 4, 5, 6, 7].includes(info?.arena_status) && c.state.world.map_id === info.map_id,
            'No active arena loading',
        )
        //9604 closes the loading page after9602 entity readiness. It must
        // neither advance the battle phase nor restart the selection timer.
        ensure(c.state.kiboDuelLoadingCompleteAt, 'Arena entities are not ready')
        return {}
    })
    on('KiboDuelArenaSetFirstReq', (c, r) => {
        const info = c.state.multiCampaign,
            group = selectedArenaGroup(c.state),
            guid = String(r.pet_guid ?? '0')
        ensure(
            info?.arena_status === 3 && group?.pet_guids.some((p) => p.guid === guid && p.id !== '0'),
            'First pet is not in arena formation',
        )
        c.state.kiboDuelFirstGuid = guid
        c.pushBefore('SCProtoKiboDuelArenaFirstInfoSync', { id: c.id, pet_guid: guid })
        return {}
    })
    on('KiboDuelArenaFirstConfirmReq', (c) => {
        const info = c.state.multiCampaign,
            group = selectedArenaGroup(c.state),
            guid = c.state.kiboDuelFirstGuid
        if ([4, 6].includes(info?.arena_status) && c.state.kiboDuelFirstConfirmedAt) return {}
        ensure(
            info?.arena_status === 3 && group?.pet_guids.some((p) => p.guid === guid && p.id !== '0'),
            'No first arena pet selected',
        )
        startNpcArenaRound(c)
        return {}
    })
    const quit = (c) => {
        if (c.state.entrust?.run) return exitEntrust(c)
        const info = c.state.multiCampaign
        ensure(info && info.status >= 2, 'No active dungeon')
        clearArenaStageBuffs(c)
        info.status = 1
        info.end_time = String(c.now)
        const { duel_id, arena_status, formation_slot, ...wire } = info
        c.pushBefore('CSProtoMultiCampaignInfoSync', { camp: [wire] })
        c.pushBefore('CSProtoCurMultiCampaignInfoSync', wire)
        if (c.state.combat?.npcDuel?.result) c.pushBefore('SCProtoKiboDuelArenaInfoSync', { status: 7 })
        const previous = c.state.worldHistory?.pop()
        ensure(previous, 'Dungeon return position unavailable')
        Object.assign(c.state.world, previous)
        retireNpcArenaActors(c.state)
        delete c.state.combat
        if (clearArenaTrialTrainer(c.state)) {
            c.pushBefore('CSProtoTrialDatas', trialPayload(c.state))
            c.pushBefore('CSProtoSyncPlayerData', { heros_info: c.state.player.heros_info })
        }
        worldSync(c)
        const returnType = tables.find('world_city', c.state.world.map_id)?.type
        c.push('CSProtoOnlineModeChange', { mode: returnType === 4 ? 2 : [2, 13].includes(returnType) ? 5 : 1 })
        delete c.state.multiCampaign
        delete c.state.kiboDuelLoadingCompleteAt
        delete c.state.kiboDuelFirstGuid
        delete c.state.kiboDuelFirstConfirmedAt
        return {}
    }
    on('MultiCampaignQuit', quit)
    on('KiboDuelQuit', (c) => {
        ensure(c.state.combat?.npcDuel?.map_id === c.state.world.map_id, 'No active NPC arena')
        return quit(c)
    })
}
