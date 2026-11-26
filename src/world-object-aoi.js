import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { WorldObjectCatalog } from './world-objects.js'
import { worldSearchVisible } from './world-search-visible.js'
import { enemyDefinition } from './enemy-state.js'
import { combatState } from './combat-state.js'
import {
    activateCombatGroup,
    combatEnemyRoot,
    combatEntityStates,
    rememberCombatEnemyPresentation,
} from './combat-enemy-lifecycle.js'
import { inactiveCampaignEnemyGroup } from './inactive-campaign-enemies.js'
import { abyssTables } from './abyss-catalog.js'
import { activeTaskWorldBattleSource } from './task-world-battle-source.js'
import { worldCondition } from './handlers/world-objects.js'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const valid = (condition, text) => ensure(condition, text, ErrorCode.GameConfig)
const catalogs = new WeakMap()
const catalog = (tables) => {
    let value = catalogs.get(tables)
    if (!value) catalogs.set(tables, (value = new WorldObjectCatalog(tables, tables.abyss_directory)))
    return value
}
const scopedTables = (tables, state) => (state.abyssRun?.map_id === state.world.map_id ? abyssTables(tables) : tables)
function identity(value) {
    const text = String(value)
    ensure(
        (typeof value !== 'number' || Number.isSafeInteger(value)) &&
            /^(0|[1-9]\d*)$/.test(text) &&
            BigInt(text) > 0n &&
            BigInt(text) <= 0xffffffffffffffffn,
        'Invalid world-object presence GUID',
        ErrorCode.InvalidArgument,
    )
    const id = BigInt(text)
    return {
        guid: text,
        kind: Number(id >> 56n),
        index: Number((id >> 32n) & 0xffffffn),
        objectId: Number(id & 0xffffffffn),
    }
}
function connectionHash(token) {
    valid(
        typeof token === 'string' && token.length > 0 && token.length <= 256,
        'World-object connection identity is unavailable',
    )
    return createHash('sha256').update(token).digest('hex')
}
function inspectLedger(value) {
    valid(
        object(value) &&
            value.version === 1 &&
            /^[a-f0-9]{64}$/.test(value.connection_hash) &&
            object(value.agents) &&
            (value.scene === null ||
                (object(value.scene) && positive(value.scene.map_id) && positive(value.scene.runtime_epoch))),
        'World-object presence ledger is malformed',
    )
    for (const [id, receipt] of Object.entries(value.agents)) {
        valid(
            /^[1-9]\d*$/.test(id) && BigInt(id) <= 0xffffffffffffffffn,
            'World-object presence receipt identity is malformed',
        )
        valid(
            object(receipt) &&
                typeof receipt.active === 'boolean' &&
                typeof receipt.source_key === 'string' &&
                receipt.source_key.length > 0 &&
                receipt.source_key.length <= 512,
            'World-object presence receipt is malformed',
        )
        const kind = Number(BigInt(id) >> 56n)
        if ([3, 4, 7].includes(kind))
            valid(
                /^enemy:[1-9]\d*:[1-9]\d*$/.test(receipt.source_key) ||
                    (!receipt.active && receipt.source_key === 'cleanup-without-admission'),
                'World enemy presence source receipt is malformed',
            )
        else {
            let source
            try {
                source = JSON.parse(receipt.source_key)
            } catch {
                valid(false, 'World-item presence source receipt is malformed')
            }
            valid(
                [6, 26].includes(kind) &&
                    Array.isArray(source) &&
                    source[0] === kind &&
                    source.every(uint) &&
                    (kind === 6
                        ? source.length === 5 && positive(source[1]) && positive(source[2]) && positive(source[3])
                        : source.length === 4 && positive(source[1])),
                'World-item presence source receipt is malformed',
            )
        }
    }
}
// Connection/scene presentation leases are deliberately separate from combat
// HP, kills, capture receipts and terminal generations. Never store the token.
export function resetWorldObjectAoiSession(state, token) {
    if (state.worldObjectAoi !== undefined) inspectLedger(state.worldObjectAoi)
    const previous = state.worldObjectAoi
    // A new connection releases active leases, not logical source receipts.
    state.worldObjectAoi = {
        version: 1,
        connection_hash: connectionHash(token),
        scene: previous?.scene ?? null,
        agents: Object.fromEntries(
            Object.entries(previous?.agents ?? {}).map(([id, receipt]) => [id, { ...receipt, active: false }]),
        ),
    }
}
function ledger(c, battle) {
    if (c.state.worldObjectAoi === undefined) resetWorldObjectAoiSession(c.state, c.combatSessionId)
    const previous = c.state.worldObjectAoi
    inspectLedger(previous)
    ensure(
        previous.connection_hash === connectionHash(c.combatSessionId),
        'World-object presence belongs to a previous connection',
        ErrorCode.InvalidTarget,
    )
    const scene =
        battle?.map_id === c.state.world.map_id && positive(battle.runtimeEpoch)
            ? { map_id: battle.map_id, runtime_epoch: battle.runtimeEpoch }
            : null
    const same = previous.scene?.map_id === scene?.map_id && previous.scene?.runtime_epoch === scene?.runtime_epoch
    const next = { ...previous, scene, agents: same ? { ...previous.agents } : {} }
    c.state.worldObjectAoi = next
    return next
}
// Read-only admission query for visual relays; never initialize actor state.
export function worldObjectAoiLeaseState(state, value, token) {
    const id = identity(value),
        leases = state.worldObjectAoi
    if (leases === undefined) return { known: false, active: false }
    inspectLedger(leases)
    const receipt = leases.agents[id.guid],
        battle = state.combat
    if (
        !receipt ||
        leases.scene?.map_id !== state.world.map_id ||
        battle?.map_id !== state.world.map_id ||
        leases.scene?.runtime_epoch !== battle.runtimeEpoch
    )
        return { known: false, active: false }
    if ([3, 4, 7].includes(id.kind)) {
        const activation = battle.enemyActivations?.[combatEnemyRoot(id.guid)]
        if (!activation || receipt.source_key !== `enemy:${activation.generation}:${activation.packIds[id.index]}`)
            return { known: false, active: false }
        if (!activation.active) return { known: true, active: false }
    } else if (id.kind === 6) {
        const run = state.playableRuns?.[id.objectId],
            source = JSON.parse(receipt.source_key)
        if (!run || run.map_id !== state.world.map_id || ![1, 2].includes(run.status))
            return { known: true, active: false }
        if (
            !Array.isArray(source) ||
            source[0] !== 6 ||
            source[1] !== id.objectId ||
            source[2] !== id.index ||
            source[4] !== run.time
        )
            return { known: false, active: false }
    } else if (id.kind === 26) {
        const dynamic = state.worldObjects?.[state.world.map_id + ':' + id.objectId]?.expand_data?.dynamic_obj
        if (
            dynamic &&
            receipt.source_key !==
                JSON.stringify([26, dynamic.spawner_id, dynamic.expand_id ?? 0, dynamic.refresh_id ?? 0])
        )
            return { known: false, active: false }
    }
    return { known: true, active: receipt.active && leases.connection_hash === connectionHash(token) }
}
function requestIds(values) {
    ensure(
        Array.isArray(values) && values.length > 0 && values.length <= 1024,
        'Invalid world-object presence batch',
        ErrorCode.InvalidArgument,
    )
    const ids = values.map(identity)
    ensure(
        new Set(ids.map((id) => id.guid)).size === ids.length,
        'Duplicate world-object presence GUID',
        ErrorCode.InvalidArgument,
    )
    return ids
}

// Current0600932d override dictionary and06028a68 fallback. Only classes
// deriving WorldItem can own WorldItemServerInstanceComponent. These are
// object-type enums, not selected world IDs or a historical table override.
const itemOverrides = new Set([601])
const otherOverrides = new Set([
    50, 53, 51, 52, 12, 302, 74, 308, 307, 70, 71, 305, 301, 14, 310, 311, 251, 252, 253, 110, 114, 112, 113, 111, 117,
    118, 119, 120, 122, 123, 116, 19, 164, 36, 82, 500, 600,
])
export function worldItemServerSpawner(tables, spawnerId) {
    const spawner = tables.find('world_spawner', spawnerId)
    ensure(spawner, 'World-object presence spawner is missing', ErrorCode.SpawnerConfIsNull)
    valid(uint(spawner.objectType) && uint(spawner.basicType), 'World-object presence spawner class is malformed')
    return itemOverrides.has(spawner.objectType) || (!otherOverrides.has(spawner.objectType) && spawner.basicType === 2)
}
function worldSource(tables, state, objectId, deleting) {
    const map = state.world.map_id,
        world = catalog(tables),
        record = state.worldObjects?.[map + ':' + objectId]
    const dynamic = record?.expand_data?.dynamic_obj
    if (dynamic) {
        // Current TDWorldmapTable.IsDynamicObject06024b4b and
        // MapService.ApplyDynamicWorldObject06028894 admit only this range.
        // Remote9199 transport retains its separate typed-snapshot contract.
        ensure(
            objectId >= 10000000 && objectId <= 99999999,
            'World-object identity is outside the current dynamic range',
            ErrorCode.InvalidTarget,
        )
        valid(
            object(dynamic) &&
                positive(dynamic.spawner_id) &&
                uint(dynamic.expand_id ?? 0) &&
                object(record.pos) &&
                ['x', 'y', 'z'].every((axis) => Number.isFinite(record.pos[axis])),
            'Saved dynamic world-object presence is malformed',
        )
        ensure(
            deleting || (record.active === true && record.complete !== true),
            'Dynamic world object is not available',
            ErrorCode.InvalidTarget,
        )
        return {
            row: { id: objectId, cityId: map },
            spawner: world.find('world_spawner', dynamic.spawner_id),
            record,
            pos: record.pos,
        }
    }
    const result = world.object(map, objectId)
    const activation = state.combat?.enemyActivations?.[((3n << 56n) | BigInt(objectId)).toString()]
    ensure(
        deleting ||
            worldSearchVisible(result.row, record, state) ||
            (activeTaskWorldBattleSource(tables, state, result.row) &&
                worldSearchVisible({ ...result.row, initStatus: 0 }, record, state)) ||
            (activation?.sourceKind === 'explicit' && activation.active),
        'World object is not available',
        ErrorCode.InvalidTarget,
    )
    return { ...result, record }
}
function describe(c, id, deleting = false) {
    ensure(
        [3, 4, 7, 26, 6].includes(id.kind),
        'GUID is not a current world-object presence source',
        ErrorCode.InvalidTarget,
    )
    const tables = scopedTables(c.tables, c.state)
    if ([3, 4, 7].includes(id.kind)) {
        if (id.kind === 3) worldSource(tables, c.state, id.objectId, deleting)
        const definition = enemyDefinition(c.tables, c.state, id.guid)
        ensure(
            definition && !definition.npc_duel,
            'World enemy is not in the current declared roster',
            ErrorCode.InvalidTarget,
        )
        ensure(
            deleting ||
                (!inactiveCampaignEnemyGroup(c.tables, c.state, id.guid) &&
                    c.state.petCaptureResults?.[id.guid]?.map_id !== c.state.world.map_id),
            'World enemy is not currently available',
            ErrorCode.InvalidTarget,
        )
        return { ...id, definition, objId: id.objectId, agentType: 4 }
    }
    if (id.kind === 26) {
        ensure(id.index === 0, 'World-map item presence index must be zero', ErrorCode.InvalidTarget)
        const source = worldSource(tables, c.state, id.objectId, deleting)
        ensure(
            source.spawner && worldItemServerSpawner(tables, source.spawner.id),
            'World-map source does not own a server-item component',
            ErrorCode.InvalidTarget,
        )
        return {
            ...id,
            objId: id.objectId,
            agentType: 8,
            sourceKey: JSON.stringify([
                26,
                source.spawner.id,
                source.record?.expand_data?.dynamic_obj?.expand_id ?? source.row.expandId ?? 0,
                source.record?.expand_data?.dynamic_obj?.refresh_id ?? 0,
            ]),
        }
    }
    const run = c.state.playableRuns?.[id.objectId]
    const row = c.tables
        .get('playable_object')
        .find((entry) => entry.playableId === id.objectId && entry.objectId === id.index)
    ensure(
        id.index > 0 &&
            row &&
            c.tables.find('playable', id.objectId) &&
            worldItemServerSpawner(c.tables, row.spawnerId),
        'Playable item is not in its current declared object catalog',
        ErrorCode.InvalidTarget,
    )
    ensure(
        deleting || (run?.map_id === c.state.world.map_id && [1, 2].includes(run.status)),
        'Playable item has no active admitted run',
        ErrorCode.InvalidTarget,
    )
    // No world-map anchor is carried by this GUID. Agent8's current Populate
    // path retains entityGuid even with obj_id0; RefreshPlayableItem binds the
    // registered owner by that full GUID. Do not refresh an unrelated map ID.
    valid(deleting || positive(run.time), 'Playable item admission time is malformed')
    return {
        ...id,
        objId: 0,
        agentType: 8,
        sourceKey: JSON.stringify([6, id.objectId, id.index, row.spawnerId, run?.time ?? 0]),
    }
}
function prepareEnemy(c, descriptor, battle) {
    const id = descriptor.guid,
        root = combatEnemyRoot(id),
        definition = descriptor.definition
    const current = battle.enemyActivations?.[root]
    ensure(current?.active !== false, 'Enemy group is not active', ErrorCode.InvalidTarget)
    const count = definition.group_size
    valid(positive(count) && count <= 256, 'World enemy roster size is malformed')
    const packIds = Array.from(
        { length: count },
        (_, slot) => enemyDefinition(c.tables, c.state, (BigInt(root) | (BigInt(slot) << 32n)).toString())?.pack_id,
    )
    valid(packIds.every(positive), 'World enemy roster is incomplete')
    let scopeKey = current?.scopeKey,
        sourceKind = current?.sourceKind ?? 'explicit',
        activatedAtMs = current ? c.now * 1000 : 0
    if (!current || current.sourceKind !== 'explicit') {
        if (descriptor.kind === 3) {
            scopeKey = `runtime:${battle.runtimeEpoch}:world:${battle.map_id}:${root}`
            sourceKind = 'runtime'
            activatedAtMs = battle.runtimeActivatedAtMs
        }
        if (descriptor.kind === 4 && definition.activation_source) {
            const source = definition.activation_source
            scopeKey = `task:${source.task_id}:${source.task_epoch}:${source.owner_kind}:${source.owner_id}:${battle.map_id}:${root}`
            sourceKind = 'task'
        }
        if (descriptor.kind === 7) {
            for (const [key, entry] of Object.entries(c.state.playableEnemies ?? {})) {
                const source = entry.entities?.find((entity) => entity.uuid === id)
                if (!key.startsWith(battle.map_id + ':') || !source || source.container !== descriptor.objectId)
                    continue
                valid(
                    positive(entry.created_at) &&
                        typeof entry.config_fingerprint === 'string' &&
                        entry.config_fingerprint.length > 0,
                    'Playable enemy activation source is malformed',
                )
                scopeKey = `playable:${key}:${source.container}:${entry.created_at}:${entry.config_fingerprint}`
                sourceKind = 'playable'
                activatedAtMs = entry.created_at * 1000
                break
            }
        }
    }
    valid(typeof scopeKey === 'string' && scopeKey.length > 0, 'World enemy activation source is unavailable')
    const sameActivation =
        current &&
        current.scopeKey === scopeKey &&
        current.sourceKind === sourceKind &&
        Array.isArray(current.packIds) &&
        current.packIds.length === packIds.length &&
        current.packIds.every((pack, slot) => pack === packIds[slot]) &&
        !packIds.some((pack, slot) => {
            const member = (BigInt(root) | (BigInt(slot) << 32n)).toString()
            return [battle.entities[member], battle.enemyTerminals?.[member]].some(
                (entity) => positive(entity?.pack_id) && entity.pack_id !== pack,
            )
        })
    // A repeated lease is not a roster projection/rebuild. Avoid needless
    // terminal rehydration into the512-entry mutation cache on simple reentry.
    if (!sameActivation)
        activateCombatGroup(c.state, {
            root,
            scopeKey,
            packIds,
            active: true,
            activatedAtMs,
            adoptExisting: !current,
            sourceKind,
        })
    const cached = combatEntityStates(battle)[id]
    valid(!cached || cached.pack_id === definition.pack_id, 'World enemy cached source identity is unavailable')
    const entity = cached ?? {
        uuid: id,
        ...definition,
        hp: definition.max_hp,
        sp: 0,
        alive_state: 0,
        updated_at: c.now,
    }
    valid(
        uint(entity.hp) && uint(entity.sp ?? 0) && [0, 1].includes(entity.alive_state ?? (entity.hp ? 0 : 1)),
        'World enemy cached life state is malformed',
    )
    // Pure appearances must not fill the bounded mutation cache and evict
    // accepted partial HP. Actual combat owns all HP/death cache writes.
    rememberCombatEnemyPresentation(c.state, id, definition.pack_id)
    return entity
}

function describeCreation(c, id) {
    try {
        return describe(c, id)
    } catch (error) {
        if (error.code !== ErrorCode.InvalidTarget || id.kind !== 3) throw error
        const tables = scopedTables(c.tables, c.state),
            row = catalog(tables).find('worldmap_' + c.state.world.map_id, id.objectId)
        if (!row?.disappearCond || activeTaskWorldBattleSource(tables, c.state, row)) throw error
        let retired
        try {
            retired = worldCondition(row.appearCond, c.state) && worldCondition(row.disappearCond, c.state)
        } catch (conditionError) {
            if (![ErrorCode.GameConfig, ErrorCode.FunctionClosed].includes(conditionError.code)) throw conditionError
            throw error
        }
        if (!retired) throw error
        // Validate the current static source, full roster and requested slot.
        // A vanished phase is not permission to swallow unknown/broken data.
        const descriptor = describe(c, id, true)
        valid(
            positive(descriptor.definition?.max_hp) && positive(descriptor.definition?.level),
            'Retired world enemy definition is malformed',
        )
        // LOCAL no-admission/drain for a known expired phase. The current
        // manager clears its pending/inflight batch on success. Omitting this
        // entry does not affirmatively cancel an active EnemyUnit, so never
        // use it for an active target or fabricate an agent/Appear/Disappear.
        return null
    }
}

export function createWorldObjectAoi(c, request) {
    const descriptors = requestIds(request.objs)
        .map((id) => describeCreation(c, id))
        .filter(Boolean)
    if (!descriptors.length) return { objs: [] }
    const battle = combatState(c.state, c.now),
        leases = ledger(c, battle),
        objs = []
    for (const descriptor of descriptors) {
        const id = descriptor.guid,
            previous = leases.agents[id],
            priorEnemy = descriptor.definition ? combatEntityStates(battle)[id] : null
        // LOCAL deterministic agent identity: opaque on the wire, admitted
        // from the current source GUID. No official allocation counter claim.
        const data = { unit_id: id }
        let entity
        if (descriptor.definition) {
            entity = prepareEnemy(c, descriptor, battle)
            // The pending ACK is returned by the handler before these pushes.
            // HP/alive cache must precede Appear releasing the native waiter.
            c.push('CSProtoObjBattleInfoSync', {
                infos: [
                    {
                        uuid: id,
                        hp: entity.hp,
                        sp: entity.sp ?? 0,
                        alive_state: entity.alive_state ?? (entity.hp ? 0 : 1),
                        final_blow_guid: entity.final_blow_guid ?? '0',
                        reason: 0,
                    },
                ],
            })
            data.fobj_base_data = { hp: entity.hp, sp: entity.sp ?? 0 }
            data.mon_base_data = {
                enemy_pack: descriptor.definition.pack_id,
                mob_cfg_id: descriptor.definition.config_id,
            }
        }
        c.push('SCProtoObjAppearNtf', {
            agent_uid: id,
            agent_type: descriptor.agentType,
            obj: {
                obj_id: descriptor.objId,
                obj_type: descriptor.kind,
                obj_data: [{ obj_index: descriptor.index, cli_battle_data: data }],
            },
            ...(descriptor.definition ? { lv: descriptor.definition.level } : {}),
        })
        if (!entity || entity.hp > 0) c.push('SCProtoControlChangeByAddNtf', { agent_uid: id, cli_data: { uuid: id } })
        const sourceKey = descriptor.definition
            ? `enemy:${battle.enemyActivations[combatEnemyRoot(id)].generation}:${descriptor.definition.pack_id}`
            : descriptor.sourceKey
        // LOCAL first logical admission/source-generation flag. Reconnecting
        // or releasing an AOI lease alone cannot make a logical actor new.
        const is_new = previous ? previous.source_key !== sourceKey : !priorEnemy
        leases.agents[id] = { active: true, source_key: sourceKey }
        objs.push({ guid: id, agent_uid: id, is_new })
    }
    // Receipts are scoped to this real runtime and finite admitted sources;
    // only active leases consume the local simultaneous-presence budget.
    valid(
        Object.values(leases.agents).filter((receipt) => receipt.active).length <= 8192,
        'World-object presence capacity is exhausted',
    )
    return { objs }
}
export function deleteWorldObjectAoi(c, request) {
    const ids = requestIds(request.u64s),
        battle = c.state.combat?.map_id === c.state.world.map_id ? c.state.combat : null
    ensure(
        ids.every(
            (id) =>
                [3, 4, 7, 26, 6].includes(id.kind) &&
                (id.kind !== 26 || id.index === 0) &&
                (id.kind !== 6 || id.index > 0),
        ),
        'GUID is not a current world-object presence source',
        ErrorCode.InvalidTarget,
    )
    const previous = c.state.worldObjectAoi
    if (previous === undefined) return {}
    inspectLedger(previous)
    ensure(
        previous.connection_hash === connectionHash(c.combatSessionId),
        'World-object presence belongs to a previous connection',
        ErrorCode.InvalidTarget,
    )
    const sameScene =
        previous.scene?.map_id === c.state.world.map_id && previous.scene?.runtime_epoch === battle?.runtimeEpoch
    const leases = { ...previous, agents: { ...previous.agents } }
    let changed = false
    for (const id of ids) {
        const previous = leases.agents[id.guid]
        // Current Native keeps its0.3s delete queue across scene leave. There
        // is no map/epoch in11237: release issued receipts, never look up old
        // cleanup GUIDs in the destination map or invent an unissued lease.
        if (!previous?.active) continue
        leases.agents[id.guid] = { ...previous, active: false }
        changed = true
        if (sameScene) {
            c.push('SCProtoControlChangeByDelNtf', { agent_uid: id.guid })
            c.push('SCProtoObjDisappearNtf', { agent_uid: id.guid })
        }
    }
    if (changed) c.state.worldObjectAoi = leases
    return {}
}

const worldFields = [
    'obj_id',
    'active',
    'complete',
    'time',
    'next_time',
    'expand_data',
    'state_data',
    'last_reward_step',
    'pos',
    'across_day',
    'gm_level',
    'gm_dungeon_id',
    'gm_dungeon_group_idx',
]
export function dynamicWorldObjectSnapshot(tables, state, mapId) {
    ensure(positive(mapId) && tables.find('world_city', mapId), 'Unknown dynamic-object map', ErrorCode.InvalidTarget)
    valid(state.worldObjects === undefined || object(state.worldObjects), 'Dynamic world-object storage is malformed')
    const objs = []
    for (const [key, record] of Object.entries(state.worldObjects ?? {})) {
        if (!key.startsWith(mapId + ':') || !record?.expand_data?.dynamic_obj) continue
        const id = Number(key.slice(String(mapId).length + 1)),
            dynamic = record.expand_data.dynamic_obj
        valid(
            positive(id) &&
                record.obj_id === id &&
                object(dynamic) &&
                positive(dynamic.spawner_id) &&
                uint(dynamic.expand_id ?? 0),
            'Saved dynamic world-object identity is malformed',
        )
        ensure(
            tables.find('world_spawner', dynamic.spawner_id),
            'Saved dynamic world-object spawner is missing',
            ErrorCode.SpawnerConfIsNull,
        )
        if (record.pos !== undefined)
            valid(
                object(record.pos) && ['x', 'y', 'z'].every((axis) => Number.isFinite(record.pos[axis])),
                'Saved dynamic world-object position is malformed',
            )
        for (const field of ['active', 'complete', 'across_day'])
            if (record[field] !== undefined)
                valid(typeof record[field] === 'boolean', 'Saved dynamic world-object flag is malformed')
        // Typed current WorldObj fields only; private claims remain untouched.
        objs.push(
            structuredClone(
                Object.fromEntries(
                    worldFields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]),
                ),
            ),
        )
    }
    return { map_id: mapId, objs }
}
