import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { activeFormationManager } from './trial-actors.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
function identity(value) {
    ensure(
        typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)),
        'Malformed battle relation identity',
        ErrorCode.GameConfig,
    )
    const text = String(value)
    ensure(
        /^[1-9][0-9]*$/.test(text) && BigInt(text) < 1n << 64n,
        'Malformed battle relation identity',
        ErrorCode.GameConfig,
    )
    return text
}
function nodes(value) {
    if (value === undefined) return []
    ensure(object(value), 'Malformed battle relation graph', ErrorCode.GameConfig)
    return Object.entries(value).map(([key, node]) => {
        ensure(
            object(node) && identity(node.id) === identity(key),
            'Malformed battle relation node',
            ErrorCode.GameConfig,
        )
        const objects = node.target_obj_ids ?? [],
            players = node.player_obj_ids ?? []
        ensure(
            Array.isArray(objects) &&
                Array.isArray(players) &&
                objects.length <= 256 &&
                players.length <= 64 &&
                players.every((id) => Number.isInteger(id) && id > 0 && id <= 0xffffffff),
            'Malformed battle relation edges',
            ErrorCode.GameConfig,
        )
        return { id: key, objects: objects.map(identity), players: players.map(String) }
    })
}

// CBT3 BattleManager.IsInBattle0600cb52 -> BattleRelationGraph0600cbc5:
// the player's FightSet UUID is the account/player ID, not its current hero.
// 10805/10806 are the existing authoritative relation-delta receivers. Do not
// infer combat from a cast, recent damage, nearby enemies or nonempty entities.
export function playerIsInBattle(state) {
    const battle = state.combat
    if (!battle || battle.map_id !== state.world.map_id) return false
    const arena = battle.npcDuel,
        campaign = state.multiCampaign
    // Current arena scene/loaded-field lifecycle; this is not a test for every
    // dungeon being a battle. Result/loading-only scenes do not imply combat.
    if (
        arena?.map_id === state.world.map_id &&
        arena.entities_sent === true &&
        !arena.result &&
        campaign?.map_id === state.world.map_id &&
        [3, 4, 6].includes(campaign.arena_status)
    )
        return true
    const graph = battle.hatred
    if (graph === undefined) return false
    ensure(object(graph), 'Malformed battle relation graph', ErrorCode.GameConfig)
    const player = identity(state.player.basic_info.id),
        manager = activeFormationManager(state),
        formation = manager?.groups?.find((entry) => entry.id === manager.cur_group),
        owned = new Set([player])
    for (const entry of formation?.heros ?? [])
        for (const id of [entry.hero_id, entry.pet_id]) if (id && id !== '0') owned.add(identity(id))
    if (formation?.control && formation.control !== '0') owned.add(identity(formation.control))
    for (const pet of state.pets ?? [])
        if (pet.hero_id && pet.hero_id !== '0' && owned.has(String(pet.hero_id))) owned.add(identity(pet.guid))
    const belongs = (initial) => {
        let id = initial
        const seen = new Set()
        // GetFightSetInfoByEntity0600cbf7 follows summon/bullet owners with a
        // native recursion guard. Cycles/missing owners cannot invent a player.
        for (let depth = 0; depth < 5 && id && id !== '0' && !seen.has(id); depth++) {
            if (owned.has(id)) return true
            seen.add(id)
            id = String(battle.summons?.[id]?.owner_id ?? battle.bullets?.[id]?.unit_id ?? '0')
        }
        return false
    }
    const players = nodes(graph.players),
        objects = nodes(graph.objects)
    for (const node of players) {
        if (node.id === player && (node.objects.some((id) => !belongs(id)) || node.players.some((id) => id !== player)))
            return true
        if (node.id !== player && (node.players.includes(player) || node.objects.some(belongs))) return true
    }
    return objects.some((node) => !belongs(node.id) && (node.players.includes(player) || node.objects.some(belongs)))
}

export function requirePlayerOutOfBattle(c, prohibitId) {
    if (!playerIsInBattle(c.state)) return
    const rule = c.tables.find('fight_prohibit', prohibitId)
    ensure(
        rule && typeof rule.words === 'string' && rule.words.length > 0,
        'Fight prohibition configuration unavailable',
        ErrorCode.GameConfig,
    )
    ensure(false, rule.words, ErrorCode.PlayerInFight)
}
