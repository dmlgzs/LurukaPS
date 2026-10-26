import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { temporaryPets, temporaryHeroes, activeFormationManager } from './trial-actors.js'
import policy from '../configs/pet-puzzle-progress-policy.json' with { type: 'json' }

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const warnings = new WeakMap()
function uuid(value) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
    if (!['string', 'number', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) return null
    const n = BigInt(value)
    return n > 0n && n < 1n << 64n ? String(n) : null
}
ensure(
    policy.version === 1 &&
        policy.officiallyVerified === false &&
        policy.contextType === 1 &&
        policy.unit === 'first-accepted-explicit-kibo-puzzle-root-completion' &&
        policy.worlds.every(
            (r) => [r.map, r.id, r.spawner, r.blueprint, r.attribute].every(positive) && [161, 162].includes(r.type),
        ) &&
        policy.playables.every((r) => positive(r.id) && r.canReset === 0),
    'Invalid pet puzzle progress policy',
    ErrorCode.GameConfig,
)
const worlds = new Map(policy.worlds.map((r) => [`${r.map}:${r.id}`, r]))
const playables = new Map(policy.playables.map((r) => [r.id, r]))
ensure(
    worlds.size === policy.worlds.length && playables.size === policy.playables.length,
    'Duplicate pet puzzle progress origin',
    ErrorCode.GameConfig,
)

function elements(tables, configId) {
    if (!positive(configId)) return []
    const row = tables.find('pet', configId)
    if (!row) return []
    const values = String(row.element).split('|').map(Number)
    return values.length && values.every(positive) ? values : []
}
function diagnostic(c, reason) {
    let accounts = warnings.get(c.tables)
    if (!accounts) warnings.set(c.tables, (accounts = new Map()))
    const id = c.state.player?.basic_info?.id
    let seen = accounts.get(id)
    if (!seen) accounts.set(id, (seen = new Set()))
    if (seen.has(reason)) return
    seen.add(reason)
    console.warn(
        '[pet-puzzle-progress]',
        JSON.stringify({ accountId: id, reason, action: 'original-award-preserved-no-credit' }),
    )
}

// This identity boundary uses server-owned records, not a fabricated client
// Entity. It cannot prove that the renderer currently has a live PetEntity or
// repeat the client's local physical/element collision calculation.
export function petPuzzleContextActor(tables, state, context) {
    if (context?.ext_type !== policy.contextType || !positive(context.ext_uint32_1)) return null
    const id = uuid(context.ext_uint64_1)
    if (!id) return null
    const registered = temporaryPets(state)
    const kind = Number(BigInt(id) >> 56n)
    const owned = (state.pets ?? []).filter(
        (pet) =>
            (kind === 2 || (kind === 0 && BigInt(id) <= 0xffffffffn)) &&
            uuid(pet.guid) === id &&
            !pet.trial &&
            !pet.trail &&
            !pet.is_trial &&
            !pet.abyss,
    )
    const transient = registered.filter((pet) => uuid(pet.guid) === id)
    if (owned.length + transient.length !== 1) return null
    const pet = owned[0] ?? transient[0]
    if (!elements(tables, pet.config_id).includes(context.ext_uint32_1)) return null
    if (transient.length) {
        const manager = activeFormationManager(state)
        const group = manager?.groups?.find((g) => g.id === manager.cur_group)
        const heroes = [...(state.player.heros_info?.heros ?? []), ...temporaryHeroes(state)]
        const slots = (group?.heros ?? []).filter((s) => uuid(s.pet_id) === id && uuid(s.hero_id) === uuid(pet.hero_id))
        if (!slots.some((slot) => heroes.some((hero) => uuid(hero.guid) === uuid(slot.hero_id)))) return null
    }
    return {
        petGuid: id,
        configId: pet.config_id,
        attribute: context.ext_uint32_1,
        scope: transient.length ? 'registered-temporary' : 'owned',
    }
}

export function petPuzzleProgressFacts(tables, state) {
    const ledger = state.petPuzzleProgress
    if (ledger === undefined) return { version: 1, revision: 0, facts: {} }
    ensure(
        object(ledger) && ledger.version === 1 && uint(ledger.revision) && object(ledger.facts),
        'Malformed pet puzzle progress ledger',
        ErrorCode.GameConfig,
    )
    const entries = Object.entries(ledger.facts)
    ensure(ledger.revision === entries.length, 'Pet puzzle progress revision mismatch', ErrorCode.GameConfig)
    for (const [key, fact] of entries) {
        const world = fact?.kind === 'world' && worlds.get(`${fact.mapId}:${fact.objectId}`)
        const playable = fact?.kind === 'playable' && playables.get(fact.playId)
        ensure(
            object(fact) &&
                uuid(fact.petGuid) === fact.petGuid &&
                positive(fact.configId) &&
                elements(tables, fact.configId).includes(fact.attribute) &&
                ['owned', 'registered-temporary'].includes(fact.scope) &&
                positive(fact.time) &&
                ((world &&
                    key === `world:${fact.mapId}:${fact.objectId}` &&
                    fact.blueprint === world.blueprint &&
                    fact.attribute === world.attribute) ||
                    (playable && key === `playable:${fact.playId}` && positive(fact.mapId))),
            'Malformed pet puzzle completion fact',
            ErrorCode.GameConfig,
        )
    }
    return ledger
}

function record(c, key, origin, context) {
    const ledger = petPuzzleProgressFacts(c.tables, c.state)
    if (ledger.facts[key]) return false
    const actor = petPuzzleContextActor(c.tables, c.state, context)
    if (!actor) {
        diagnostic(c, context ? 'unqualified-context' : 'missing-context')
        return false
    }
    ensure(
        positive(c.now) && ledger.revision < 0xffffffff,
        'Invalid pet puzzle completion clock/count',
        ErrorCode.GameConfig,
    )
    c.state.petPuzzleProgress = {
        version: 1,
        revision: ledger.revision + 1,
        facts: { ...ledger.facts, [key]: { ...origin, ...actor, time: c.now } },
    }
    return true
}

export function recordPetPuzzleWorldCompletion(c, row, spawner, before, current, context) {
    const entry = worlds.get(`${c.state.world.map_id}:${row.id}`)
    if (
        !entry ||
        entry.spawner !== spawner.id ||
        entry.type !== spawner.objectType ||
        entry.blueprint !== (row.blueprint || spawner.blueprint) ||
        row.initialCompleteState ||
        before.complete ||
        before.claimed ||
        current.complete !== true ||
        current.claims?.complete !== true
    )
        return false
    if (context && context.ext_uint32_1 !== entry.attribute) {
        petPuzzleProgressFacts(c.tables, c.state)
        diagnostic(c, 'world-attribute-mismatch')
        return false
    }
    return record(
        c,
        `world:${entry.map}:${entry.id}`,
        { kind: 'world', mapId: entry.map, objectId: entry.id, blueprint: entry.blueprint },
        context,
    )
}

export function recordPetPuzzlePlayableCompletion(c, row, finish, context) {
    if (
        !playables.has(row.id) ||
        row.canReset !== 0 ||
        finish.play_id !== row.id ||
        finish.map_id !== c.state.world.map_id
    )
        return false
    return record(c, `playable:${row.id}`, { kind: 'playable', mapId: finish.map_id, playId: row.id }, context)
}

export function petPuzzleProgressRule(tokens) {
    return tokens?.length === 4 && tokens[0] === 12048 && tokens[1] === 0 && tokens[2] === 0 && positive(tokens[3])
}
export function petPuzzleProgressValue(tables, state, tokens, facts = new Map()) {
    if (!petPuzzleProgressRule(tokens)) return null
    if (!facts.has('pet-puzzle-progress'))
        facts.set('pet-puzzle-progress', petPuzzleProgressFacts(tables, state).revision)
    return facts.get('pet-puzzle-progress')
}
