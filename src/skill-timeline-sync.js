import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { temporaryHeroes, temporaryPets, isRetiredTrialActor } from './trial-actors.js'
import { enemyDefinition } from './enemy-state.js'
import { worldObjectAoiLeaseState } from './world-object-aoi.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const skillIds = new WeakMap()

function identity(value) {
    ensure(
        (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
            /^[1-9]\d*$/.test(String(value)) &&
            BigInt(value) < 1n << 64n,
        'Invalid skill timeline actor identity',
        ErrorCode.InvalidArgument,
    )
    return BigInt(value).toString()
}
function position(value, name) {
    ensure(object(value), 'Missing skill timeline ' + name, ErrorCode.InvalidArgument)
    ensure(
        Object.entries(value).every(
            ([key, n]) =>
                ['x', 'y', 'z'].includes(key) && Number.isSafeInteger(n) && n >= -0x80000000 && n <= 0x7fffffff,
        ),
        'Invalid skill timeline ' + name,
        ErrorCode.InvalidArgument,
    )
    // ProtoHelper.ToServerPos uses hundredths; omitted scalar zeroes stay zero.
    return { ...value }
}
function knownSkill(tables, id) {
    let ids = skillIds.get(tables)
    if (!ids) {
        const skills = tables.get('skill'),
            levels = tables.get('skill_level')
        ensure(
            Array.isArray(skills) && Array.isArray(levels),
            'Skill timeline catalogue is damaged',
            ErrorCode.GameConfig,
        )
        // Some current programs have levels without a display-table row.
        ids = new Set([...skills.map((row) => row.id), ...levels.map((row) => row.skillId)].filter(positive))
        skillIds.set(tables, ids)
    }
    return ids.has(id)
}
function caster(c, id) {
    const hero = [...c.state.player.heros_info.heros, ...temporaryHeroes(c.state)].find(
        (row) => String(row.guid) === id,
    )
    if (hero) {
        ensure(
            c.tables.find('hero', hero.conf_id),
            'Skill timeline hero configuration is missing',
            ErrorCode.GameConfig,
        )
        return
    }
    const pet = [...c.state.pets, ...temporaryPets(c.state)].find((row) => String(row.guid) === id)
    if (pet) {
        ensure(
            c.tables.find('pet', pet.config_id),
            'Skill timeline pet configuration is missing',
            ErrorCode.PetConfNotExist,
        )
        return
    }
    const battle = c.state.combat
    const lease = worldObjectAoiLeaseState(c.state, id, c.combatSessionId)
    if (lease.known && !lease.active) return false
    const entity = battle?.map_id === c.state.world.map_id && battle.entities?.[id]
    ensure(
        entity || lease.active,
        'Skill timeline actor is not owned or present in this scene',
        ErrorCode.InvalidTarget,
    )
    const definition = enemyDefinition(c.tables, c.state, id)
    ensure(definition, 'Skill timeline scene actor configuration is missing', ErrorCode.NoEnemyConf)
    ensure(
        !entity || entity.config_id === definition.config_id,
        'Skill timeline scene actor identity changed',
        ErrorCode.GameConfig,
    )
}

// Current11122/11123 is a no-reply visual relay, not movement or cast admission.
// StartTimeline0600c740 sends only for locally simulated actors; the receiver
// stores this pose for the remote timeline. SkillStart's pause gate is different,
// so an active cast record is not required by this packet's actual contract.
export function syncSkillTimelinePosition(c, request) {
    const id = identity(request.uuid)
    if (isRetiredTrialActor(c.state, id) || c.state.petCaptureResults?.[id]) return
    ensure(positive(request.skill_id), 'Invalid skill timeline program', ErrorCode.InvalidArgument)
    ensure(knownSkill(c.tables, request.skill_id), 'Unknown skill timeline program', ErrorCode.InvalidArgument)
    if (caster(c, id) === false) return
    ensure(positive(c.state.world?.map_id), 'Skill timeline scene identity is damaged', ErrorCode.GameConfig)
    const value = {
        uuid: id,
        skill_id: request.skill_id,
        pos: position(request.pos, 'position'),
        rotation: position(request.rotation, 'rotation'),
    }
    c.broadcast({ kind: 'map', map: c.state.world.map_id, sender: c.id }, 'SCProtoSkillTimelinePosInfo', value)
}
