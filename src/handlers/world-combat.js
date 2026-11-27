import { ensure } from './common.js'
import { ErrorCode } from '../error-codes.js'
import { actor } from './combat.js'
import { u64, combatState, boundedSet } from '../combat-state.js'
import { isRetiredTrialActor, temporaryPets } from '../trial-actors.js'
import { completedEnemyGroup } from '../enemy-group-completion.js'
import { recordBossFirstClear } from '../boss-first-chests.js'
import { inactiveCampaignEnemyGroup } from '../inactive-campaign-enemies.js'
import { arenaNativeSummonOwner } from '../npc-kibo-unit-grade.js'
import { requirePetModel } from '../pet-model-eligibility.js'
import { enemyDefinition } from '../enemy-state.js'
import { combatEntityStates, combatEnemyRoot, rememberCombatEnemyPresentation } from '../combat-enemy-lifecycle.js'
import {
    beginCombatSnapshotPublication,
    plannedCombatInitialization,
    recordCombatInitialization,
} from '../combat-scene-snapshots.js'
function runtime(c) {
    const state = combatState(c.state, c.now)
    state.summons ??= {}
    state.summonRequests ??= {}
    state.hatred ??= { objects: {}, players: {} }
    return state
}
function clearHatredWithDeltas(c, battle, id, isPlayer = false) {
    // Clear only affected edges. A target reset may also reset its entire
    // monster group; full10808 would reset unrelated battles as well.
    const before = Object.fromEntries(
        Object.entries(battle.hatred).map(([field, entries]) => [
            field,
            Object.fromEntries(Object.entries(entries).map(([key, info]) => [key, { ...info }])),
        ]),
    )
    const changed = clearHatred(battle, id, isPlayer)
    if (!changed) return false
    for (const [field, entries] of Object.entries(before))
        for (const [key, old] of Object.entries(entries)) {
            const next = battle.hatred[field][key]
            const targets = old.target_obj_ids.filter((target) => !next?.target_obj_ids.includes(target))
            const players = old.player_obj_ids.filter((player) => !next?.player_obj_ids.includes(player))
            if (targets.length || players.length)
                c.pushBefore(field === 'players' ? 'CSProtoPlayerHatredIncSync' : 'CSProtoObjHatredIncSync', {
                    inc: false,
                    info: { id: old.id, target_obj_ids: targets, player_obj_ids: players },
                })
        }
    return true
}
export function resetPlayerBattleRelations(c) {
    const battle = c.state.combat
    if (battle?.map_id !== c.state.world.map_id || !battle.hatred) return false
    ensure(
        typeof battle.hatred === 'object' &&
            !Array.isArray(battle.hatred) &&
            battle.hatred.objects &&
            battle.hatred.players,
        'Malformed player battle relations',
        ErrorCode.GameConfig,
    )
    for (const entries of Object.values(battle.hatred)) {
        ensure(
            entries && typeof entries === 'object' && !Array.isArray(entries),
            'Malformed player battle relations',
            ErrorCode.GameConfig,
        )
        for (const info of Object.values(entries))
            ensure(
                info && Array.isArray(info.target_obj_ids) && Array.isArray(info.player_obj_ids),
                'Malformed player battle relations',
                ErrorCode.GameConfig,
            )
    }
    return clearHatredWithDeltas(c, battle, String(c.id), true)
}
function clearHatred(battle, id, isPlayer = false) {
    let changed = false
    const table = battle.hatred[isPlayer ? 'players' : 'objects']
    if (table[id]) {
        delete table[id]
        changed = true
    }
    for (const entries of Object.values(battle.hatred))
        for (const [key, info] of Object.entries(entries)) {
            const field = isPlayer ? 'player_obj_ids' : 'target_obj_ids',
                next = info[field].filter((value) => String(value) !== id)
            if (next.length !== info[field].length) {
                info[field] = next
                changed = true
                if (!info.target_obj_ids.length && !info.player_obj_ids.length) delete entries[key]
            }
        }
    return changed
}
function removeAssociated(battle, id) {
    delete battle.skills[id]
    delete battle.entities[id]
    for (const [key, b] of Object.entries(battle.bullets)) if (b.unit_id === id) delete battle.bullets[key]
    for (const [key, e] of Object.entries(battle.elements))
        if (e.tar_id === id || e.buff?.creator_id === id) delete battle.elements[key]
}
export function retireCapturedEnemy(c, id) {
    const battle = runtime(c),
        previous = battle.entities[id] ?? { uuid: id }
    removeAssociated(battle, id)
    clearHatredWithDeltas(c, battle, id)
    battle.entities[id] = { ...previous, uuid: id, hp: 0, alive_state: 1, captured: true, updated_at: c.now }
}
export function pruneInactiveCampaignRelations(c, ids = []) {
    const battle = runtime(c),
        groups = new Map()
    const candidates = [
        ...ids,
        ...Object.keys(battle.hatred.objects),
        ...Object.values(battle.hatred.objects).flatMap((info) => info.target_obj_ids),
        ...Object.values(battle.hatred.players).flatMap((info) => info.target_obj_ids),
    ]
    for (const id of candidates) {
        const group = c.state.sharedTeamRun
            ? c.sharedTeamRuns.inactiveEnemyGroup(c, id)
            : inactiveCampaignEnemyGroup(c.tables, c.state, id)
        if (group) groups.set(group.root, group)
    }
    if (!groups.size) return false
    battle.hatred = Object.fromEntries(
        Object.entries(battle.hatred).map(([name, entries]) => [
            name,
            Object.fromEntries(Object.entries(entries).map(([key, info]) => [key, { ...info }])),
        ]),
    )
    for (const group of groups.values()) {
        for (const id of group.members) clearHatred(battle, id)
        c.push('CSProtoHatredResetSync', { is_player: false, obj_id: group.root })
    }
    return true
}
export function finishEnemyGroupRelations(c, id, authoritativeGroup = null) {
    // Only the shared ledger supplies authoritativeGroup after its canonical
    // roster is dead. Ordinary scenes retain their existing completion proof.
    const group = authoritativeGroup ?? completedEnemyGroup(c.tables, c.state, id)
    if (!group) return false
    const battle = runtime(c)
    if (battle.completedRelationGroups?.[group.root]) {
        if (!authoritativeGroup) recordBossFirstClear(c, id)
        return false
    }
    battle.completedRelationGroups = { ...battle.completedRelationGroups, [group.root]: true }
    battle.hatred = Object.fromEntries(
        Object.entries(battle.hatred).map(([name, entries]) => [
            name,
            Object.fromEntries(Object.entries(entries).map(([key, info]) => [key, { ...info }])),
        ]),
    )
    for (const member of group.members) clearHatred(battle, member)
    c.push('CSProtoHatredResetSync', { is_player: false, obj_id: group.root })
    if (!authoritativeGroup) recordBossFirstClear(c, id)
    return true
}
// Public scene-ready/rebuild hook. EntityService caches10009 even before an
// actor is recreated, including killerUID; do not replay a stale activation.
export function replayCombatEnemyTerminals(c) {
    const battle = c.state.combat
    if (battle?.map_id !== c.state.world.map_id) return 0
    const states = combatEntityStates(battle),
        infos = []
    for (const [id, terminal] of Object.entries(battle.enemyTerminals ?? {})) {
        const activation = battle.enemyActivations?.[combatEnemyRoot(id)]
        if (!activation?.active || activation.generation !== terminal.generation || states[id]?.hp !== 0) continue
        const current = enemyDefinition(c.tables, c.state, id)
        if (!current || current.npc_duel || current.pack_id !== terminal.pack_id) continue
        infos.push({
            uuid: id,
            hp: 0,
            sp: terminal.sp ?? 0,
            alive_state: 1,
            reason: 0,
            ...(terminal.final_blow_guid ? { final_blow_guid: terminal.final_blow_guid } : {}),
        })
    }
    for (let index = 0; index < infos.length; index += 256)
        c.pushBefore('CSProtoObjBattleInfoSync', { infos: infos.slice(index, index + 256) })
    return infos.length
}
// Call after destination WorldMapSync/SceneMode in the same output stream:
// EntityService.RemoveCacheBy9103Call can discard earlier10009 cold blocks.
// Terminal replay remains a separate, later scene-ready step.
export function publishCombatEnemyActivations(c) {
    beginCombatSnapshotPublication(c)
    if (c.state.combat) c.state.combat = { ...c.state.combat, bullets: { ...c.state.combat.bullets } }
    const battle = combatState(c.state, c.now),
        pending = { ...battle.enemyAlivePending }
    for (const [id, entry] of Object.entries(c.state.combatEnemyPresentations?.[battle.map_id] ?? {}))
        if (entry.runtimeEpoch !== battle.runtimeEpoch && pending[id] === undefined) pending[id] = { runtime: true }
    const states = combatEntityStates(battle),
        infos = [],
        consumed = []
    for (const [id, event] of Object.entries(pending)) {
        const activation = battle.enemyActivations?.[combatEnemyRoot(id)]
        consumed.push(id)
        if (
            activation &&
            (!activation.active || (event.generation !== undefined && event.generation !== activation.generation))
        )
            continue
        const definition = enemyDefinition(c.tables, c.state, id)
        if (!definition || definition.npc_duel) continue
        if (c.state.petCaptureResults?.[id]?.map_id === battle.map_id) continue
        const object = c.state.worldObjects?.[`${battle.map_id}:${definition.object_id}`]
        if (object?.complete || object?.state_data?.complete || object?.active === false) continue
        const cached = states[id]
        // A real death in this new generation supersedes an unflushed alive
        // notification. Never revive it or heal already accepted new damage.
        if (cached?.hp === 0 && cached.alive_state === 1) continue
        const hp = cached?.pack_id === definition.pack_id && cached.hp !== undefined ? cached.hp : definition.max_hp
        ensure(
            Number.isSafeInteger(hp) && hp > 0 && hp <= 0xffffffff,
            'Invalid fresh combat activation HP',
            ErrorCode.GameConfig,
        )
        const sp = cached?.pack_id === definition.pack_id ? (cached.sp ?? 0) : 0
        ensure(
            Number.isSafeInteger(sp) && sp >= 0 && sp <= 0xffffffff,
            'Invalid fresh combat activation SP',
            ErrorCode.GameConfig,
        )
        infos.push(
            plannedCombatInitialization(c, { uuid: id, hp, sp, alive_state: 0, final_blow_guid: '0', reason: 0 }),
        )
        rememberCombatEnemyPresentation(c.state, id, definition.pack_id)
    }
    battle.enemyAlivePending = { ...battle.enemyAlivePending }
    for (const id of consumed) delete battle.enemyAlivePending[id]
    for (let index = 0; index < infos.length; index += 256) {
        const chunk = infos.slice(index, index + 256)
        c.pushBefore('CSProtoObjBattleInfoSync', { infos: chunk })
        recordCombatInitialization(c, chunk)
    }
    return infos.length
}
export function registerWorldCombat(on) {
    on('SwitchPetAction', (c, r) => {
        const uuid = u64(r.uuid),
            type = r.type ?? 0
        if (isRetiredTrialActor(c.state, uuid)) return
        const owned = c.state.pets.find((pet) => pet.guid === uuid)
        ensure(owned || temporaryPets(c.state).some((p) => p.guid === uuid), 'Pet not owned')
        if (owned) requirePetModel(c.tables, owned)
        // Remote presentation only. Echoing this to the owner sets remoteSwitch locally.
        const battle = runtime(c)
        battle.petPresentation ??= {}
        boundedSet(battle.petPresentation, uuid, { type, updated_at: c.now }, 256)
        c.broadcast({ kind: 'map', map: c.state.world.map_id, sender: c.id }, 'CSProtoSwitchPetActionBC', {
            uuid,
            type,
        })
    })
    on('KiboDuelBTTreeRunning', (c, r) => {
        const guids = r.guids ?? []
        ensure(guids.length <= 256, 'Too many behavior-tree actors')
        // Client telemetry only: this does not establish a duel result or grant rewards.
        runtime(c).kiboDuelTreeReport = { guids: [...new Set(guids.map((id) => actor(c, id)))], received_at: c.now }
    })
    for (const [name, field] of [
        ['ObjHatredIncSync', 'objects'],
        ['PlayerHatredIncSync', 'players'],
    ])
        on(name, (c, r) => {
            ensure(r.info, 'Missing hatred data')
            const sharedActors = c.state.sharedTeamRun ? c.sharedTeamRuns.relationActors(c) : null,
                relationActor = (value) => {
                    if (!sharedActors) return actor(c, value)
                    const id = u64(value)
                    ensure(sharedActors.has(id), 'Battle relation actor is not in this shared encounter')
                    return id
                },
                inactive = (id) =>
                    c.state.sharedTeamRun
                        ? c.sharedTeamRuns.inactiveEnemyGroup(c, id)
                        : inactiveCampaignEnemyGroup(c.tables, c.state, id),
                id = relationActor(r.info.id),
                targets = r.info.target_obj_ids ?? [],
                players = r.info.player_obj_ids ?? []
            ensure(targets.length <= 256 && players.length <= 64, 'Hatred list too large')
            if (c.state.petCaptureResults?.[id])
                return { inc: !!r.inc, info: { id, target_obj_ids: [], player_obj_ids: [] } }
            const targetIds = [...new Set(targets.map((id) => relationActor(id)))].filter(
                    (id) => !c.state.petCaptureResults?.[id],
                ),
                playerIds = [...new Set(players)]
            ensure(
                playerIds.every((n) => Number.isInteger(n) && n > 0 && (!sharedActors || sharedActors.has(String(n)))),
                'Invalid hatred player',
            )
            const battle = runtime(c)
            const root = (BigInt(id) & ~(0xffffffn << 32n)).toString()
            if (inactive(id)) {
                pruneInactiveCampaignRelations({ ...c, push: c.pushBefore }, [id])
                return { inc: false, info: { id, target_obj_ids: targetIds, player_obj_ids: playerIds } }
            }
            if (battle.completedRelationGroups?.[root])
                return { inc: false, info: { id, target_obj_ids: targetIds, player_obj_ids: playerIds } }
            if (r.inc) {
                const dormant = targetIds.filter((target) => inactive(target))
                if (dormant.length) pruneInactiveCampaignRelations({ ...c, push: c.pushBefore }, dormant)
                const retired = targetIds.filter(
                    (target) =>
                        dormant.includes(target) ||
                        battle.completedRelationGroups?.[(BigInt(target) & ~(0xffffffn << 32n)).toString()],
                )
                if (retired.length) {
                    targetIds.splice(0, targetIds.length, ...targetIds.filter((target) => !retired.includes(target)))
                    c.pushBefore('CSProto' + name, {
                        inc: false,
                        info: { id, target_obj_ids: retired, player_obj_ids: [] },
                    })
                }
            }
            const table = battle.hatred[field],
                previous = table[id] ?? { id, target_obj_ids: [], player_obj_ids: [] }
            const value = {
                id,
                target_obj_ids: r.inc
                    ? [...new Set([...previous.target_obj_ids, ...targetIds])]
                    : previous.target_obj_ids.filter((x) => !targetIds.includes(x)),
                player_obj_ids: r.inc
                    ? [...new Set([...previous.player_obj_ids, ...playerIds])]
                    : previous.player_obj_ids.filter((x) => !playerIds.includes(x)),
            }
            ensure(value.target_obj_ids.length <= 256 && value.player_obj_ids.length <= 64, 'Hatred list too large')
            if (!value.target_obj_ids.length && !value.player_obj_ids.length) delete table[id]
            else boundedSet(table, id, value, 512)
            return { inc: !!r.inc, info: { id, target_obj_ids: targetIds, player_obj_ids: playerIds } }
        })
    on('HatredResetSync', (c, r) => {
        const id = actor(c, r.obj_id),
            battle = runtime(c)
        clearHatred(battle, id, !!r.is_player)
        return { is_player: !!r.is_player, obj_id: id }
    })
    on('HatredResetToHomeSync', (c, r) => {
        const id = actor(c, r.obj_id),
            battle = runtime(c)
        clearHatred(battle, id)
        return { obj_id: id }
    })
    on('CreateSummon', (c, r) => {
        const owner = u64(r.unit_id)
        if (owner !== '0') actor(c, owner)
        const info = r.summon_info
        ensure(info && [1, 2, 3, 4, 5].includes(info.summon_type), 'Invalid summon data')
        const configId = info.config_id ?? 0
        ensure(
            configId > 0 ||
                (configId === 0 &&
                    info.summon_type === 3 &&
                    u64(info.unit_id) !== '0' &&
                    c.tables.find('skill', info.skill_id)),
            'Invalid summon data',
        )
        info.config_id = configId
        ensure((info.attrButeInfos ?? []).length <= 256, 'Too many summon attributes')
        const index = u64(r.verify_info?.battle_index)
        ensure(index !== '0', 'Missing summon battle index')
        const battle = runtime(c)
        // Client battle indices restart with a new connection. Old session receipts
        // cannot establish a retry in this one; retire their transient summons only.
        if (c.combatSessionId && battle.summonSession !== c.combatSessionId) {
            for (const id of Object.keys(battle.summons)) {
                removeAssociated(battle, id)
                clearHatred(battle, id)
            }
            battle.summons = {}
            battle.summonRequests = {}
            battle.summonSession = c.combatSessionId
        }
        const requestKey = index,
            previous = battle.summonRequests[requestKey]
        if (previous) {
            ensure(
                previous.owner_id === owner &&
                    previous.config_id === info.config_id &&
                    previous.summon_type === info.summon_type &&
                    (previous.skill_id ?? 0) === (info.skill_id ?? 0) &&
                    (u64(info.unit_id) === '0' || u64(info.unit_id) === previous.unit_id),
                'Summon index reused for another object',
            )
            c.push('SCProtoCreateSummon', { unit_id: previous.removed ? '0' : previous.unit_id, battle_index: index })
            return
        }
        ensure(Object.keys(battle.summons).length < 256, 'Too many active summons')
        let id = u64(info.unit_id)
        if (id !== '0') {
            ensure(info.summon_type === 3, 'Unexpected client summon ID')
            ensure(
                BigInt(id) >> 56n === 17n && (BigInt(id) & 0xffffffffn) === BigInt(c.id),
                'Invalid client summon owner',
            )
        } else {
            const sequence = BigInt(c.state.nextSummonSequence ?? '0') + 1n
            ensure(sequence < 0x800000n, 'Summon identity exhausted')
            id = ((17n << 56n) | ((0x800000n + sequence) << 32n) | BigInt(c.id)).toString()
            c.state.nextSummonSequence = sequence.toString()
        }
        ensure(!battle.summons[id], 'Summon identity already in use')
        const record = {
            unit_id: id,
            owner_id: owner,
            ...(battle.npcDuel?.map_id === c.state.world.map_id
                ? {
                      native_owner: arenaNativeSummonOwner(c, owner),
                      native_owner_scope: {
                          generation: battle.npcDuel.generation,
                          epoch: battle.npcDuel.origin_epoch ?? 0,
                      },
                  }
                : {}),
            battle_index: index,
            config_id: info.config_id,
            summon_type: info.summon_type,
            info: { ...structuredClone(info), unit_id: id },
            created_at: c.now,
            request_key: requestKey,
        }
        if (Object.keys(battle.summonRequests).length >= 1024) {
            const obsolete = Object.keys(battle.summonRequests).find((key) => battle.summonRequests[key].removed)
            ensure(obsolete, 'Summon request cache full')
            delete battle.summonRequests[obsolete]
        }
        battle.summons[id] = record
        battle.summonRequests[requestKey] = {
            unit_id: id,
            owner_id: owner,
            config_id: info.config_id,
            summon_type: info.summon_type,
            skill_id: info.skill_id ?? 0,
        }
        c.push('SCProtoCreateSummon', { unit_id: id, battle_index: index })
    })
    on('RemoveSummon', (c, r) => {
        const id = u64(r.unit_id),
            battle = runtime(c),
            record = battle.summons[id]
        if (!record) return
        delete battle.summons[id]
        if (battle.summonRequests[record.request_key]) battle.summonRequests[record.request_key].removed = true
        removeAssociated(battle, id)
        clearHatredWithDeltas(c, battle, id)
        c.push('CSProtoRemoveSummonSync', { unit_id: id, op: r.op ?? 0, op_time: u64(r.op_time) })
    })
    on('FightBreak', (c, r) => {
        const infos = r.infos ?? []
        ensure(infos.length <= 256, 'Too many break values')
        const battle = runtime(c)
        battle.breakValues ??= {}
        for (const info of infos) {
            const id = actor(c, info.tarId)
            if (c.state.petCaptureResults?.[id]) continue
            ensure(info.val && Number.isInteger(info.val.val), 'Missing break value')
            boundedSet(battle.breakValues, id, { ...info.val, updated_at: c.now }, 512)
        }
    })
}
