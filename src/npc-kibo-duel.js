import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { arenaTrainer } from './npc-kibo-trainer.js'
import { requirePetModel } from './pet-model-eligibility.js'

const list = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)

// The CBT3 preparation page validates trial membership and levelType through
// petDuelState.checkPetCanUse: 0 = owned, 1 = mixed, 2 = trial-only.
export function validateNpcDuelFormation(tables, state, duel, formation) {
    ensure(formation?.pet_guids?.length === 8, 'Arena formation unavailable')
    const allowedTrials = new Set(list(duel.kiboList))
    const seen = new Set()
    let count = 0
    for (const pet of formation.pet_guids) {
        const id = String(pet.id ?? '0')
        if (id === '0') continue
        const key = `${!!pet.is_trial}:${id}`
        ensure(!seen.has(key), 'Duplicate arena pet')
        seen.add(key)
        if (pet.is_trial) {
            ensure(duel.levelType !== 0 && allowedTrials.has(Number(id)), 'Trial pet is not allowed in this duel')
            ensure(
                tables.find('trial_pet', Number(id)),
                'Trial pet configuration unavailable',
                ErrorCode.TrialPetNotExist,
            )
        } else {
            ensure(duel.levelType !== 2, 'This duel requires trial pets')
            const owned = state.pets.find((candidate) => String(candidate.guid) === id)
            ensure(owned, 'Arena pet not owned')
            requirePetModel(tables, owned)
        }
        count++
    }
    ensure(count >= duel.minimumKibo, 'Not enough arena pets')
    const trainer = arenaTrainer(tables, state, duel, formation)
    if (duel.trialRole)
        ensure(
            formation.hero === String(trainer.conf_id) ||
                formation.hero === trainer.guid ||
                state.player.heros_info.heros.some((hero) => hero.guid === formation.hero),
            'Invalid arena trial trainer',
        )
    return formation
}

export function selectedArenaGroup(state) {
    const run = state.combat?.npcDuel,
        campaign = state.multiCampaign
    if (
        run?.formation_snapshot &&
        campaign?.duel_id === run.duel_id &&
        campaign.start_time === run.start_time &&
        state.world.map_id === run.map_id
    )
        return run.formation_snapshot
    const slot = state.multiCampaign?.formation_slot ?? state.player.group_mgrs?.find((m) => m.type === 6)?.cur_group
    return state.kiboDuelGroups?.[slot]
}

export function npcDuelEntry(tables, duelId) {
    const duel = tables.find('kibo_duel', duelId)
    ensure(duel?.type === 1 && duel.duelMode === 1, 'Not an NPC arena duel')
    const dungeon = tables.find('dungeon', duel.dungeonId)
    ensure(
        dungeon?.dungeonType === 400 && dungeon.gameplayID === duel.id,
        'NPC duel dungeon mapping unavailable',
        ErrorCode.DungeonConfNotExist,
    )
    const map = tables.find('kibo_duel_map', duel.mapId)
    const coordinates = list(dungeon.position)
    ensure(map, 'NPC duel scene configuration unavailable', ErrorCode.KiboDuelMapConfNotExist)
    ensure(
        Number.isInteger(Number(map.art)) && Number(map.art) > 0,
        'NPC duel scene art unavailable',
        ErrorCode.KiboDuelConfArtMapNone,
    )
    ensure(
        coordinates.length === 6 && coordinates.every(Number.isFinite),
        'Invalid NPC duel scene coordinates',
        ErrorCode.GameConfig,
    )
    const enemyPets = list(duel.enemy)
    ensure(
        enemyPets.length === 8 && enemyPets.every((id) => tables.find('pet', id)),
        'NPC duel enemy roster unavailable',
        ErrorCode.GameConfig,
    )
    ensure(
        [0, 1, 2].includes(duel.levelType) &&
            Number.isInteger(duel.minimumKibo) &&
            duel.minimumKibo > 0 &&
            duel.minimumKibo <= 8,
        'NPC duel formation rules unavailable',
        ErrorCode.GameConfig,
    )
    return { duel, dungeon, map, coordinates, enemyPets }
}

// Editable presets are not the live roster. Protect inventory sources until
// the matching arena run is left, including benched or defeated actors.
export function petInActiveNpcDuel(state, guid) {
    const run = state.combat?.npcDuel,
        campaign = state.multiCampaign
    if (
        !run ||
        !campaign?.duel_id ||
        campaign.duel_id !== run.duel_id ||
        campaign.start_time !== run.start_time ||
        state.world.map_id !== run.map_id
    )
        return false
    const id = String(guid)
    return (
        Object.values(run.actors ?? {}).some((actor) => actor.camp === 1 && String(actor.source_guid) === id) ||
        (run.formation_snapshot?.pet_guids ?? []).some((pet) => !pet.is_trial && String(pet.guid || pet.id) === id)
    )
}
