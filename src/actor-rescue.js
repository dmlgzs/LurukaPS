import policy from '../configs/actor-rescue-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { u64, combatState } from './combat-state.js'
import { activeFormationManager, temporaryHeroes } from './trial-actors.js'
import { heroBattleLimits, heroModules } from './battle.js'

// These are protocol AliveStateType values, not local EEntityAliveState values.
const ALIVE = 0,
    OVER_HURT = 2,
    COMPLETE = 10000

function ownedHero(c, value) {
    ensure(typeof value !== 'number' || Number.isSafeInteger(value), 'Unsafe rescue actor identity')
    const id = u64(value)
    const hero = [...c.state.player.heros_info.heros, ...temporaryHeroes(c.state)].find((h) => h.guid === id)
    ensure(id !== '0' && hero, 'Rescue hero is not owned or active', ErrorCode.HeroNotExist)
    const manager = activeFormationManager(c.state)
    const formation = manager?.groups.find((g) => g.id === manager.cur_group)
    ensure(
        formation?.heros.some((h) => h.hero_id === id),
        'Rescue hero is not deployed',
        ErrorCode.InvalidTarget,
    )
    const saved = c.state.player.heros_info.battle_infos.find((h) => h.hero_id === id)
    ensure(
        saved &&
            Number.isSafeInteger(saved.hp) &&
            saved.hp >= 0 &&
            Number.isInteger(saved.alive_state) &&
            saved.alive_state >= 0 &&
            saved.alive_state <= OVER_HURT,
        'Malformed rescue hero battle state',
        ErrorCode.GameConfig,
    )
    return { id, hero, saved, formation }
}

function gameNumber(c, key) {
    const value = Number(c.tables.get('game').find((row) => row.title === key)?.value)
    ensure(Number.isFinite(value) && value > 0, 'Missing rescue configuration: ' + key, ErrorCode.GameConfig)
    return value
}

export function rescueActors(c, request) {
    const rows = request.rescue_infos ?? []
    ensure(Array.isArray(rows) && rows.length > 0 && rows.length <= 16, 'Invalid rescue batch')
    const battle = combatState(c.state, c.now)
    battle.rescueSources = { ...battle.rescueSources }
    const notifications = [],
        changed = new Map()
    for (const row of rows) {
        ensure(Number.isSafeInteger(row.val) && row.val > 0 && row.val <= 0xffffffff, 'Invalid rescue increment')
        const source = ownedHero(c, row.from_uuid),
            target = ownedHero(c, row.tar_uuid)
        const self = source.id === target.id
        ensure(
            self || source.formation.control === source.id,
            'Rescuer is not the controlled hero',
            ErrorCode.InvalidTarget,
        )
        ensure(
            self || (source.saved.alive_state === ALIVE && source.saved.hp > 0),
            'Rescuer is not alive',
            ErrorCode.InvalidTarget,
        )
        // A report already in flight when rescue finished is a resync, never a heal.
        if (target.saved.alive_state === ALIVE && target.saved.hp > 0) {
            notifications.push({ from_uuid: source.id, tar_uuid: target.id, final_val: 0 })
            continue
        }
        ensure(
            target.saved.alive_state === OVER_HURT && target.saved.hp === 0,
            'Rescue target is not over-hurt',
            ErrorCode.InvalidTarget,
        )
        if (!self) {
            const sourcePos = battle.entities[source.id]?.pos ?? c.state.world.pos
            const targetPos = battle.entities[target.id]?.pos ?? c.state.world.pos
            ensure(
                [sourcePos, targetPos].every((p) => p && ['x', 'y', 'z'].every((k) => Number.isFinite(p[k]))),
                'Malformed rescue actor position',
                ErrorCode.GameConfig,
            )
            const maxDistance = gameNumber(c, 'RESCUE_DISTANCE') * 100
            ensure(
                Math.hypot(...['x', 'y', 'z'].map((k) => sourcePos[k] - targetPos[k])) <= maxDistance,
                'Rescue target is too far away',
                ErrorCode.InteractDistanceTooFar,
            )
            battle.rescueSources[source.id] = target.id
        }
        const before = target.saved.rescue_val ?? 0
        ensure(
            Number.isInteger(before) && before >= 0 && before < COMPLETE,
            'Malformed saved rescue progress',
            ErrorCode.GameConfig,
        )
        const total = Math.min(COMPLETE, before + row.val)
        target.saved.rescue_val = total
        notifications.push({ from_uuid: source.id, tar_uuid: target.id, final_val: total })
        if (total === COMPLETE) {
            // TODO: official post-rescue HP remains unproven. Keep this explicit
            // local policy outside the handler rather than inventing a percentage.
            const rate = gameNumber(c, policy.completionHpGameKey)
            ensure(rate <= COMPLETE, 'Invalid rescue HP policy', ErrorCode.GameConfig)
            const maxHp = heroBattleLimits(heroModules(c.tables, c.state, target.hero)).hp
            ensure(Number.isSafeInteger(maxHp) && maxHp > 0, 'Invalid rescue maximum HP', ErrorCode.GameConfig)
            target.saved.hp = Math.max(1, Math.floor((maxHp * rate) / COMPLETE))
            target.saved.alive_state = ALIVE
            target.saved.rescue_val = 0
            delete target.saved.final_blow_guid
            for (const [from, to] of Object.entries(battle.rescueSources))
                if (to === target.id) delete battle.rescueSources[from]
        }
        const value = {
            uuid: target.id,
            hp: target.saved.hp,
            alive_state: target.saved.alive_state,
            rescue_val: target.saved.rescue_val,
            reason: 0,
        }
        if (total === COMPLETE) value.final_blow_guid = '0'
        changed.set(target.id, value)
        if (battle.entities[target.id])
            battle.entities[target.id] = {
                ...battle.entities[target.id],
                ...value,
                updated_at: c.now,
            }
    }
    // Both endpoints are notifications, with no fabricated RPC acknowledgement.
    c.push('CSProtoRescueObjNtf', { rescue_infos: notifications })
    c.broadcast({ kind: 'map', map: c.state.world.map_id, sender: c.id }, 'CSProtoRescueObjNtf', {
        rescue_infos: notifications,
    })
    if (changed.size) {
        const info = { infos: [...changed.values()] }
        c.push('CSProtoObjBattleInfoSync', info)
        c.broadcast({ kind: 'map', map: c.state.world.map_id, sender: c.id }, 'CSProtoObjBattleInfoSync', info)
    }
}

export function cancelRescue(c) {
    const battle = c.state.combat
    // The packet has no actor/target field. Only this account's current map
    // rescue associations are local to this transaction; earned target progress
    // belongs to the target and must survive a rescuer releasing the button.
    if (battle?.map_id === c.state.world.map_id && battle.rescueSources) battle.rescueSources = {}
    // Current CBT3 OnRescueCanceBC ignores the uint32 payload. Account ID is an
    // explicit local sender convention, not a recovered official field meaning.
    const notice = { u32: c.id }
    c.push('CSProtoRescueCancelBC', notice)
    c.broadcast({ kind: 'map', map: c.state.world.map_id, sender: c.id }, 'CSProtoRescueCancelBC', notice)
}
