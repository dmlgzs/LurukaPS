import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { abyssPetGuid } from './abyss-roster.js'
import { migratePetPresetWire } from './pet-guid-preset-wire.js'
import { parsePetGuid, petGuidOwner } from './pet-guid.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
function rows(value) {
    ensure(value === undefined || Array.isArray(value), 'Malformed pet reference list', ErrorCode.GameConfig)
    return value ?? []
}
function entries(value) {
    ensure(value === undefined || object(value), 'Malformed pet reference map', ErrorCode.GameConfig)
    return Object.entries(value ?? {})
}
const values = (value) => entries(value).map(([, row]) => row)
function rekey(parent, name, mapping) {
    if (parent?.[name] === undefined) return
    const result = {}
    for (const [key, row] of entries(parent[name])) {
        const target = mapping[key] ?? key
        ensure(
            !Object.hasOwn(result, target),
            'Pet reference migration collides with an existing fact',
            ErrorCode.GameConfig,
        )
        result[target] = row
    }
    parent[name] = result
}
// Released factual identities may survive only in an archive, preset or paid
// receipt. Reserve them without rewriting that immutable historical evidence.
export function petReferenceAllocationFloor(state, protocol) {
    const owner = petGuidOwner(state)
    let next = 1
    const take = (value) => {
        if (value === undefined || value === null || value === '0' || value === 0) return
        const id = parsePetGuid(value)
        if (id.type === 2 && id.ownerId === owner) next = Math.max(next, id.index + 1)
    }
    const keys = (map) => {
        for (const [key] of entries(map)) take(key)
    }
    const preset = (group) => {
        for (const pet of rows(group?.pet_guids))
            if (!pet.is_trial) {
                take(pet.id)
                take(pet.guid)
            }
    }
    const manager = (row) => {
        for (const group of rows(row?.groups)) {
            for (const slot of rows(group.heros)) take(slot.pet_id)
            preset(group)
            if (row.type === 6 && group.pet_duel_group_info !== undefined) {
                ensure(protocol, 'Encoded pet reservations require the current protocol', ErrorCode.GameConfig)
                migratePetPresetWire(protocol, group.pet_duel_group_info, {})
                let decoded
                try {
                    decoded = protocol.decode('cs.PetDuelGroupInfo', Buffer.from(group.pet_duel_group_info, 'base64'))
                } catch {
                    ensure(false, 'Malformed encoded pet reservation', ErrorCode.GameConfig)
                }
                preset(decoded)
            }
        }
    }
    for (const pet of rows(state.pets)) take(pet.guid)
    for (const row of rows(state.player?.heros_info?.heros)) take(row.pet_id)
    for (const row of rows(state.player?.group_mgrs)) manager(row)
    manager(state.homeFormationBackup)
    manager(state.abyssRun?.previous_manager)
    for (const row of rows(state.player?.basic_info?.info?.pet)) take(row.guid)
    for (const name of ['petCaressPeriods', 'petSkillRolls', 'petEvolutionHistory', 'petEvolutionProfiles'])
        keys(state[name])
    keys(state.petStarSoulProgress?.entries)
    keys(state.petMutation?.pets)
    take(state.petCaressProgress?.guid)
    for (const row of values(state.petCaptureResults)) take(row.guid)
    for (const row of values(state.hatchReceipts)) take(row.petGuid)
    for (const row of values(state.charKiboClaims)) take(row.guid)
    for (const row of values(state.playableChoiceReceipts)) take(row.pet_guid)
    for (const name of ['playableRuns', 'playableFinishes'])
        for (const row of values(state[name])) take(row.selected_pet_guid)
    for (const row of values(state.petPuzzleProgress?.facts)) take(row.petGuid)
    keys(state.compatibilityDiagnostics?.suspendedHeroPetBindings)
    for (const row of values(state.compatibilityDiagnostics?.suspendedHeroFormations))
        for (const slot of rows(row.group?.heros)) take(slot.pet_id)
    for (const row of values(state.petMutation?.claimResults)) {
        for (const pet of rows(row.pets)) take(pet.pet_guid)
        const snapshot = row.primary?.qualification_snapshot
        for (const pet of [...rows(snapshot?.beneficiaries), ...rows(snapshot?.excluded)]) take(pet.pet_guid)
    }
    const home = state.home
    for (const id of rows(home?.stationPets)) take(id)
    for (const build of rows(home?.builds)) {
        take(build.station_pet_guid)
        take(build.collect_build_data?.pet_guid)
        for (const key of ['plant_pet', 'water_pet', 'harvest_pet']) take(build.auto_info?.[key])
    }
    for (const row of values(home?.collectionProduction)) take(row.pet)
    keys(home?.productionWork?.pets)
    for (const row of values(home?.productionWork?.jobs)) take(row.worker)
    for (const ranch of values(home?.ranches)) {
        take(ranch.harvest_pet)
        for (const row of [...rows(ranch.product_pets), ...rows(ranch.drops), ...rows(ranch.bonus?.pendingBonus)])
            take(row.pet_guid)
    }
    for (const row of values(state.roulettes)) if (row.type === 1) for (const id of rows(row.guid)) take(id)
    take(state.mountRideId)
    take(state.world?.mount)
    if (state.world?.status === 1) take(state.world.status_arg)
    take(state.world?.mountActionLifecycle?.mount)
    for (const row of values(state.kiboDuelGroups)) preset(row)
    take(state.kiboDuelFirstGuid)
    for (const row of values(state.activities)) {
        for (const run of values(row.kiboTour?.runs)) {
            for (const id of rows(run.pet_ids)) take(id)
            for (const pet of rows(run.pet_experience)) take(pet.pet_id)
        }
        for (const receipt of values(row.kiboTour?.receipts)) {
            for (const id of rows(receipt.pet_ids)) take(id)
            for (const pet of rows(receipt.experience)) take(pet.pet_id)
        }
    }
    for (const slot of rows(state.entrust?.run?.repeat_formation?.slots)) take(slot.pet_id)
    const abyss = (run) => {
        for (const pet of rows(run?.pets)) take(pet.source_guid)
    }
    abyss(state.abyssRun)
    for (const mode of values(state.abyss?.modes)) for (const level of values(mode.levels)) abyss(level.resume)
    for (const level of values(state.abyss?.rotation?.levels)) abyss(level.resume)
    for (const row of values(state.combat?.npcDuel?.actors)) if (row.camp === 1) take(row.source_guid)
    for (const row of values(state.retiredNpcArenaActors)) if (row.camp === 1) take(row.source_guid)
    return next
}
export function migratePetReferences(state, mapping, protocol) {
    const encodedPresets = []
    const derived = Object.fromEntries(
            Object.entries(mapping).map(([old, current]) => [abyssPetGuid(old), abyssPetGuid(current)]),
        ),
        actorMap = { ...mapping, ...derived }
    const field = (row, key, map = mapping) => {
        if (row && Object.hasOwn(row, key) && Object.hasOwn(map, String(row[key]))) row[key] = map[String(row[key])]
    }
    const ids = (parent, key, map = mapping) => {
        if (parent?.[key] !== undefined) parent[key] = rows(parent[key]).map((id) => map[String(id)] ?? id)
    }
    const preset = (group) => {
        if (!group) return
        for (const pet of rows(group.pet_guids))
            if (!pet.is_trial) {
                field(pet, 'id')
                field(pet, 'guid')
            }
    }
    const formation = (manager) => {
        if (!manager) return
        for (const [index, group] of rows(manager.groups).entries()) {
            for (const hero of rows(group.heros)) field(hero, 'pet_id', actorMap)
            preset(group)
            if (manager.type === 6 && group.pet_duel_group_info !== undefined) {
                const original = group.pet_duel_group_info,
                    current = migratePetPresetWire(protocol, original, mapping)
                if (current !== original)
                    encodedPresets.push({ managerType: manager.type, groupIndex: index, groupId: group.id, original })
                group.pet_duel_group_info = current
            }
        }
    }
    for (const hero of rows(state.player?.heros_info?.heros)) field(hero, 'pet_id')
    for (const manager of rows(state.player?.group_mgrs)) formation(manager)
    formation(state.homeFormationBackup)
    // Compatibility/paid/puzzle/sealed producer archives stay RAW. The root
    // aliases link their original attribution without changing historic facts.
    for (const pet of rows(state.player?.basic_info?.info?.pet)) field(pet, 'guid')
    for (const key of ['petCaressPeriods', 'petSkillRolls', 'petEvolutionProfiles', 'petEvolutionHistory'])
        rekey(state, key, mapping)
    field(state.petCaressProgress, 'guid')
    rekey(state.petStarSoulProgress, 'entries', mapping)
    rekey(state.petMutation, 'pets', mapping)
    for (const row of values(state.petMutation?.pets)) field(row.pending, 'petGuid')
    for (const receipt of values(state.petCaptureResults)) field(receipt, 'guid')
    for (const receipt of values(state.hatchReceipts)) field(receipt, 'petGuid')
    for (const receipt of values(state.charKiboClaims)) field(receipt, 'guid')
    for (const receipt of values(state.playableChoiceReceipts)) field(receipt, 'pet_guid')
    for (const key of ['playableRuns', 'playableFinishes'])
        for (const run of values(state[key])) field(run, 'selected_pet_guid')
    field(state, 'mountRideId')
    field(state.world, 'mount')
    if (state.world?.status === 1) field(state.world, 'status_arg')
    field(state.world?.mountActionLifecycle, 'mount')
    for (const row of values(state.roulettes)) if (row.type === 1) ids(row, 'guid')
    for (const row of values(state.kiboDuelGroups)) preset(row)
    field(state, 'kiboDuelFirstGuid')
    const home = state.home
    if (home) {
        ids(home, 'stationPets')
        for (const build of rows(home.builds)) {
            field(build, 'station_pet_guid')
            for (const key of ['plant_pet', 'water_pet', 'harvest_pet']) field(build.auto_info, key)
            field(build.collect_build_data, 'pet_guid')
        }
        for (const job of values(home.collectionProduction)) field(job, 'pet')
        rekey(home.productionWork, 'pets', mapping)
        for (const job of values(home.productionWork?.jobs)) field(job, 'worker')
        for (const ranch of values(home.ranches)) {
            field(ranch, 'harvest_pet')
            for (const slot of rows(ranch.product_pets)) field(slot, 'pet_guid')
        }
    }
    for (const activity of values(state.activities))
        for (const run of values(activity.kiboTour?.runs)) {
            ids(run, 'pet_ids')
            for (const pet of rows(run.pet_experience)) field(pet, 'pet_id')
        }
    for (const slot of rows(state.entrust?.run?.repeat_formation?.slots)) field(slot, 'pet_id')
    // FO9 profiles/interim IDs are never traversed as permanent identities.
    for (const trial of [state.trialGroup, state.cultTrial])
        for (const hero of rows(trial?.heroes)) field(hero, 'pet_id')
    const challenges = (parts) => {
        for (const part of rows(parts)) for (const slot of rows(part.heros)) field(slot.hero, 'pet_guid', actorMap)
    }
    const abyss = (run) => {
        if (!run) return
        for (const pet of rows(run.pets)) {
            if (Object.hasOwn(mapping, String(pet.source_guid)))
                ensure(
                    pet.guid === abyssPetGuid(pet.source_guid),
                    'Abyss source and derived pet identity disagree',
                    ErrorCode.GameConfig,
                )
            field(pet, 'source_guid')
            field(pet, 'guid', derived)
        }
        for (const hero of rows(run.heroes)) field(hero, 'pet_id', derived)
        rekey(run, 'petAttrs', derived)
        rekey(run, 'pet_hp', derived)
        for (const attrs of values(run.petAttrs)) field(attrs, 'hero_guid', derived)
        challenges(run.challenges)
        formation(run.previous_manager)
    }
    abyss(state.abyssRun)
    const levels = [
        ...values(state.abyss?.modes).flatMap((mode) => values(mode.levels)),
        ...values(state.abyss?.rotation?.levels),
    ]
    for (const level of levels) {
        abyss(level.resume)
        challenges(level.challenge_list)
    }
    const combat = state.combat
    if (combat) {
        for (const name of [
            'entities',
            'skills',
            'petSp',
            'energySpecs',
            'energyRemainders',
            'shields',
            'petPresentation',
        ])
            rekey(combat, name, actorMap)
        for (const row of values(combat.entities)) {
            field(row, 'uuid', actorMap)
            field(row, 'final_blow_guid', actorMap)
        }
        for (const row of values(combat.enemyTerminals)) field(row, 'final_blow_guid', actorMap)
        for (const row of values(combat.skills)) field(row, 'unit_id', actorMap)
        for (const row of values(combat.bullets)) field(row, 'unit_id', actorMap)
        for (const name of ['summons', 'summonRequests'])
            for (const row of values(combat[name])) field(row, 'owner_id', actorMap)
        for (const row of values(combat.summons)) field(row.native_owner, 'guid', actorMap)
        for (const name of ['objects', 'players']) {
            rekey(combat.hatred, name, actorMap)
            for (const row of values(combat.hatred?.[name])) {
                field(row, 'id', actorMap)
                ids(row, 'target_obj_ids', actorMap)
            }
        }
        ids(combat.kiboDuelTreeReport, 'guids', actorMap)
        for (const row of values(combat.reboundRequests)) field(row, 'cast_id', actorMap)
        for (const row of values(combat.elements)) {
            field(row, 'tar_id', actorMap)
            for (const key of ['attacker_id', 'executor_id', 'creator_id', 'source_id']) field(row.buff, key, actorMap)
        }
        const compound = (name, fields, keyOf) => {
            if (combat[name] === undefined) return
            const result = {}
            for (const [key, row] of entries(combat[name])) {
                const affected = fields.some((key) => Object.hasOwn(actorMap, String(row[key])))
                if (affected) ensure(key === keyOf(row), 'Malformed compound pet actor reference', ErrorCode.GameConfig)
                for (const key of fields) field(row, key, actorMap)
                const next = affected ? keyOf(row) : key
                ensure(!Object.hasOwn(result, next), 'Compound pet reference collision', ErrorCode.GameConfig)
                result[next] = row
            }
            combat[name] = result
        }
        compound('skillEffects', ['uuid'], (row) => `${row.uuid}:${row.skill_id}`)
        compound('perfectDefenses', ['defender', 'target'], (row) => `${row.defender}:${row.target}`)
        compound('combineAttacks', ['attack_id', 'target_id'], (row) => `${row.attack_id}:${row.target_id}`)
        if (combat.energyActorKey !== undefined) {
            ensure(
                typeof combat.energyActorKey === 'string' && /^(?:\d+(?::\d+)*)?$/.test(combat.energyActorKey),
                'Malformed energy actor key',
                ErrorCode.GameConfig,
            )
            combat.energyActorKey = combat.energyActorKey
                .split(':')
                .map((id) => actorMap[id] ?? id)
                .join(':')
        }
        const arena = combat.npcDuel
        preset(arena?.formation_snapshot)
        for (const row of values(arena?.actors)) if (row.camp === 1) field(row, 'source_guid')
        rekey(arena, 'ultra_choices', mapping)
    }
    for (const row of values(state.retiredNpcArenaActors)) if (row.camp === 1) field(row, 'source_guid')
    for (const row of values(state.personalBuffSources)) field(row, 'actorUuid', actorMap)
    return { encodedPresets }
}
