import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff
const rootMask = ~(0xffffffn << 32n)
export function combatEnemyRoot(id) {
    const text = String(id)
    if (!/^\d+$/.test(text)) return null
    const value = BigInt(text)
    return [3n, 4n, 7n].includes(value >> 56n) ? (value & rootMask).toString() : null
}
function milliseconds(value) {
    const text = String(value ?? 0)
    ensure(
        /^\d+$/.test(text) && BigInt(text) <= 0xffffffffffffffffn,
        'Invalid combat activation timestamp',
        ErrorCode.GameConfig,
    )
    return BigInt(text)
}
function retiredRelations(graph, root) {
    if (!graph) return graph
    return Object.fromEntries(
        Object.entries(graph).map(([kind, nodes]) => [
            kind,
            Object.fromEntries(
                Object.entries(nodes).flatMap(([id, info]) => {
                    if (kind === 'objects' && combatEnemyRoot(id) === root) return []
                    const next = {
                        ...info,
                        target_obj_ids: info.target_obj_ids.filter((id) => combatEnemyRoot(id) !== root),
                    }
                    return next.target_obj_ids.length || next.player_obj_ids.length ? [[id, next]] : []
                }),
            ),
        ]),
    )
}

// Call only from an authoritative group activation/projection. scopeKey comes
// from the admitted run/scene identity, not a request-supplied generation.
// A true->false->true active edge is a new wave even with identical UID/pack.
export function activateCombatGroup(
    state,
    { root, scopeKey, packIds, active = true, activatedAtMs = 0, adoptExisting = false, sourceKind = 'explicit' },
) {
    const battle = state.combat
    ensure(
        battle?.map_id === state.world.map_id &&
            combatEnemyRoot(root) === String(root) &&
            typeof scopeKey === 'string' &&
            scopeKey.length > 0 &&
            scopeKey.length <= 512 &&
            Array.isArray(packIds) &&
            packIds.length > 0 &&
            packIds.length <= 256 &&
            packIds.every(positive) &&
            typeof active === 'boolean' &&
            ['explicit', 'runtime', 'task', 'playable'].includes(sourceKind),
        'Invalid authoritative combat group activation',
        ErrorCode.GameConfig,
    )
    const previous = battle.enemyActivations?.[root]
    const sourceMismatch = [...Object.entries(battle.entities), ...Object.entries(battle.enemyTerminals ?? {})].some(
        ([id, entity]) =>
            combatEnemyRoot(id) === root &&
            positive(entity.pack_id) &&
            entity.pack_id !== packIds[Number((BigInt(id) >> 32n) & 0xffffffn)],
    )
    const replaced =
        !!previous &&
        (previous.scopeKey !== scopeKey ||
            previous.packIds.length !== packIds.length ||
            previous.packIds.some((id, index) => id !== packIds[index]) ||
            (!previous.active && active) ||
            sourceMismatch)
    let activation = previous
    if (!previous || replaced) {
        const generation = battle.nextEnemyGeneration ?? 1
        ensure(
            positive(generation) && generation < 0xffffffff,
            'Combat enemy activation generation exhausted',
            ErrorCode.GameConfig,
        )
        battle.nextEnemyGeneration = generation + 1
        let barrier = milliseconds(activatedAtMs)
        const runtimeBarrier = milliseconds(battle.runtimeActivatedAtMs)
        if (runtimeBarrier > barrier) barrier = runtimeBarrier
        if ((replaced || sourceMismatch || !adoptExisting) && battle.last_base_time !== undefined) {
            const causal = milliseconds(battle.last_base_time) + 1n
            if (causal > barrier) barrier = causal
        }
        activation = {
            scopeKey,
            packIds: [...packIds],
            active,
            generation,
            activatedAtMs: barrier.toString(),
            sourceKind,
        }
        if (replaced || sourceMismatch || !adoptExisting) {
            battle.entities = Object.fromEntries(
                Object.entries(battle.entities).filter(([id]) => combatEnemyRoot(id) !== root),
            )
            battle.enemyTerminals = Object.fromEntries(
                Object.entries(battle.enemyTerminals ?? {}).filter(([id]) => combatEnemyRoot(id) !== root),
            )
            battle.completedRelationGroups = { ...battle.completedRelationGroups }
            delete battle.completedRelationGroups[root]
            battle.hatred = retiredRelations(battle.hatred, root)
            if (active) {
                const pending = { ...battle.enemyAlivePending }
                for (let slot = 0; slot < packIds.length; slot++)
                    pending[(BigInt(root) | (BigInt(slot) << 32n)).toString()] = { generation, pack_id: packIds[slot] }
                battle.enemyAlivePending = pending
            }
        }
    } else if (previous.active !== active || previous.sourceKind !== sourceKind)
        activation = { ...previous, active, sourceKind }
    if (activation !== previous) battle.enemyActivations = { ...battle.enemyActivations, [root]: activation }
    if (!previous && adoptExisting) {
        for (const [id, entity] of Object.entries(battle.entities))
            if (
                combatEnemyRoot(id) === root &&
                entity.hp === 0 &&
                entity.alive_state === 1 &&
                !entity.captured &&
                activation.packIds[Number((BigInt(id) >> 32n) & 0xffffffn)] === entity.pack_id
            )
                recordCombatEnemyDeath(state, id, entity)
    }
    // Rehydrate this group's compact terminal facts before a scene projector
    // reads the bounded entity cache. Unrelated cache entries stay bounded.
    let copied = false
    for (let slot = 0; slot < activation.packIds.length; slot++) {
        const id = (BigInt(root) | (BigInt(slot) << 32n)).toString(),
            terminal = battle.enemyTerminals?.[id]
        if (!terminal || terminal.generation !== activation.generation || activation.packIds[slot] !== terminal.pack_id)
            continue
        const cached = battle.entities[id]
        if (cached?.hp === 0 && cached.alive_state === 1 && cached.pack_id === terminal.pack_id) continue
        if (!copied) {
            battle.entities = { ...battle.entities }
            copied = true
        }
        if (!cached && Object.keys(battle.entities).length >= 512)
            delete battle.entities[Object.keys(battle.entities)[0]]
        battle.entities[id] = { ...terminal }
    }
    return activation
}

// Identity-only presentation journal: it is not a death/HP ledger. A new
// legitimate runtime can clear old client hp0 sync blocks for known fixed IDs.
export function rememberCombatEnemyPresentation(state, id, packId) {
    const root = combatEnemyRoot(id),
        kind = root ? BigInt(root) >> 56n : 0n,
        battle = state.combat
    if (![3n, 4n].includes(kind) || !battle?.runtimeEpoch) return
    const maps = state.combatEnemyPresentations ?? {},
        actors = maps[battle.map_id] ?? {},
        previous = actors[id]
    if (previous?.runtimeEpoch === battle.runtimeEpoch && previous.pack_id === packId) return
    state.combatEnemyPresentations = {
        ...maps,
        [battle.map_id]: { ...actors, [id]: { runtimeEpoch: battle.runtimeEpoch, pack_id: packId } },
    }
}

export function recordCombatEnemyDeath(state, id, entity) {
    const battle = state.combat,
        root = combatEnemyRoot(id),
        activation = battle?.enemyActivations?.[root]
    if (!activation || entity.npc_duel || entity.captured) return
    ensure(
        entity.hp === 0 &&
            entity.alive_state === 1 &&
            activation.packIds[Number((BigInt(id) >> 32n) & 0xffffffn)] === entity.pack_id,
        'Invalid authoritative combat terminal fact',
        ErrorCode.GameConfig,
    )
    const value = {
        uuid: String(id),
        generation: activation.generation,
        pack_id: entity.pack_id,
        config_id: entity.config_id,
        hp: 0,
        alive_state: 1,
        sp: entity.sp ?? 0,
        level: entity.level,
        max_hp: entity.max_hp,
        object_id: entity.object_id,
        slot: entity.slot,
        group_size: entity.group_size,
        updated_at: entity.updated_at,
        ...(entity.final_blow_guid ? { final_blow_guid: entity.final_blow_guid } : {}),
    }
    battle.enemyTerminals = { ...battle.enemyTerminals, [id]: value }
}

export function combatEnemyReportIsCurrent(state, id, eventTime) {
    const battle = state.combat,
        activation = battle?.enemyActivations?.[combatEnemyRoot(id)]
    if (!activation) return true
    if (!activation.active) return false
    return milliseconds(eventTime) >= milliseconds(activation.activatedAtMs)
}

export function combatEntityStates(battle) {
    const result = { ...battle?.entities }
    for (const [id, terminal] of Object.entries(battle?.enemyTerminals ?? {})) {
        const activation = battle.enemyActivations?.[combatEnemyRoot(id)]
        if (
            activation?.generation === terminal.generation &&
            activation.packIds[Number((BigInt(id) >> 32n) & 0xffffffn)] === terminal.pack_id &&
            (!result[id] || result[id].pack_id === terminal.pack_id)
        )
            result[id] = { ...result[id], ...terminal }
    }
    return result
}
