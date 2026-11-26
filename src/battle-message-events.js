import source from '../configs/current-battle-message-sources.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { WorldObjectCatalog } from './world-objects.js'
import { TaskGraphs, nodeConditions } from './tasks.js'
import { taskPackageEligible } from './task-package-scope.js'
import { enemyDefinition } from './enemy-state.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff,
    positive = (n) => uint(n) && n > 0,
    object = (v) => v && typeof v === 'object' && !Array.isArray(v),
    hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    models = new WeakMap()
ensure(
    source.schemaVersion === 1 &&
        source.clientVersion === '1.0.0' &&
        source.packageVersion === '3217420' &&
        source.origin === 'CURRENT_CLIENT_STATIC' &&
        source.authority === 'LOCAL-published-current-world-task-battle' &&
        source.conditionId === 61009 &&
        Array.isArray(source.fsms) &&
        source.fsms.length > 0,
    'Current battle-message source catalogue is malformed',
    ErrorCode.GameConfig,
)
const bindings = new Map()
for (const row of source.fsms) {
    ensure(
        positive(row.id) &&
            !bindings.has(row.id) &&
            typeof row.path === 'string' &&
            hash(row.assetSha256) &&
            Array.isArray(row.messages) &&
            row.messages.length > 0 &&
            row.messages.every(
                (m) =>
                    m.key === 61009 &&
                    Array.isArray(m.args) &&
                    m.args.length === 2 &&
                    positive(m.args[0]) &&
                    m.args[1] === 1,
            ),
        'Current battle-message producer binding is malformed',
        ErrorCode.GameConfig,
    )
    bindings.set(row.id, row)
}
const known = new Set(source.fsms.flatMap((row) => row.messages.map((m) => m.args[0])))
function progress(state) {
    const p = state.battleMessageProgress
    if (p === undefined) return null
    ensure(
        object(p) && p.version === 1 && object(p.values) && object(p.sources),
        'Battle-message permanent progress is malformed',
        ErrorCode.GameConfig,
    )
    for (const [key, value] of Object.entries(p.values)) {
        const proof = p.sources[key]
        ensure(
            /^[1-9]\d*$/.test(key) &&
                positive(Number(key)) &&
                value === 1 &&
                object(proof) &&
                proof.origin === 'LOCAL_CLIENT_CONTRACT' &&
                [
                    proof.map_id,
                    proof.object_id,
                    proof.battle_fsm_type,
                    proof.generation,
                    proof.runtime_epoch,
                    proof.task_id,
                    proof.node_id,
                ].every(positive) &&
                hash(proof.asset_sha256) &&
                uint(proof.time),
            'Battle-message permanent source receipt is malformed',
            ErrorCode.GameConfig,
        )
    }
    ensure(
        Object.keys(p.sources).every((key) => Object.hasOwn(p.values, key)),
        'Battle-message source receipt has no value',
        ErrorCode.GameConfig,
    )
    return p
}
export function battleMessageCount(state, id) {
    ensure(positive(id), 'Invalid battle-message counter identity', ErrorCode.GameConfig)
    return progress(state)?.values[id] ?? 0
}
function model(tables) {
    let m = models.get(tables)
    if (!m) models.set(tables, (m = { world: new WorldObjectCatalog(tables), graphs: new TaskGraphs(tables) }))
    return m
}
function taskOwner(tables, state, m, row, terminal) {
    const matches = []
    for (const task of state.tasks ?? []) {
        const graph = m.graphs.get(task.task_id)
        if (!taskPackageEligible(graph.config)) continue
        const live = task.nodes.filter((node) => !task.finish_nodes?.includes(node.node_id)),
            nodes = live.map((node) => ({ declared: graph.nodes.get(node.node_id), progress: node }))
        if (terminal)
            for (const id of task.finish_nodes ?? []) {
                const declared = graph.nodes.get(id)
                if (declared && live.some((node) => declared.nextNodeIdList?.includes(node.node_id)))
                    nodes.push({ declared, progress: null })
            }
        for (const { declared, progress: node } of nodes) {
            ensure(declared, 'Battle-message task node is missing', ErrorCode.TaskNoNodeId)
            for (const [index, condition] of nodeConditions(declared).entries()) {
                const base = condition.__type_TaskConditionBaseData,
                    data = base?.__type_TaskCondBattleTriggerData
                if (
                    condition.conditionId !== 2500 ||
                    data?.checkNameType !== 5 ||
                    data.count !== 1 ||
                    data.npcId !== row.id ||
                    base.mapData?.sceneId !== state.world.map_id
                )
                    continue
                if (node) {
                    ensure(
                        Array.isArray(node.node_values) && uint(node.node_values[index]),
                        'Battle-message target progress is malformed',
                        ErrorCode.GameConfig,
                    )
                    if (!terminal && (node.node_values[index] >= 1 || node.client_cond_after?.[index] === true))
                        continue
                }
                matches.push({ task_id: task.task_id, node_id: declared.id })
            }
        }
    }
    ensure(matches.length <= 1, 'Battle-message task source is ambiguous', ErrorCode.GameConfig)
    return matches[0]
}
// Payload contains no map/FSM/node/generation. This bounded client-authority
// policy is LOCAL; it does not claim to recover the official backend checker.
function resolveSource(c, id) {
    const s = c.state,
        b = s.combat,
        l = s.worldObjectAoi,
        map = s.world.map_id
    if (!b || b.map_id !== map || !positive(b.runtimeEpoch) || !l) return null
    ensure(
        l.version === 1 && hash(l.connection_hash) && object(l.agents),
        'Battle-message presence ledger is malformed',
        ErrorCode.GameConfig,
    )
    if (
        typeof c.combatSessionId !== 'string' ||
        createHash('sha256').update(c.combatSessionId).digest('hex') !== l.connection_hash ||
        l.scene?.map_id !== map ||
        l.scene.runtime_epoch !== b.runtimeEpoch
    )
        return null
    const m = model(c.tables),
        sources = []
    for (const [root, a] of Object.entries(b.enemyActivations ?? {})) {
        ensure(
            /^[1-9]\d*$/.test(root) && BigInt(root) <= 0xffffffffffffffffn,
            'Malformed battle-message activation identity',
            ErrorCode.GameConfig,
        )
        const key = BigInt(root)
        if (key >> 56n !== 3n || ((key >> 32n) & 0xffffffn) !== 0n) continue
        ensure(
            object(a) &&
                positive(a.generation) &&
                typeof a.active === 'boolean' &&
                Array.isArray(a.packIds) &&
                a.packIds.length > 0 &&
                a.packIds.length <= 256 &&
                a.packIds.every(positive),
            'Malformed battle-message enemy source',
            ErrorCode.GameConfig,
        )
        if (!a.active) continue
        const objectId = Number(key & 0xffffffffn),
            row = m.world.find('worldmap_' + map, objectId)
        if (!row || row.cityId !== map || c.tables.find('world_spawner', row.spawnerId)?.objectType !== 50) continue
        const group = c.tables.find('world_enemy_group', row.expandId)
        ensure(group, 'Battle-message enemy group is missing', ErrorCode.GameConfig)
        const binding = bindings.get(group.battleFsmType)
        if (!binding?.messages.some((message) => message.args[0] === id)) continue
        if (s.worldObjects?.[map + ':' + objectId]?.active === false) continue
        const members = a.packIds.map((pack, slot) => {
            const guid = (key | (BigInt(slot) << 32n)).toString(),
                lease = l.agents[guid],
                published = s.combatEnemyPresentations?.[map]?.[guid],
                definition = enemyDefinition(c.tables, s, guid),
                dead = b.enemyTerminals?.[guid]
            if (
                !lease ||
                typeof lease.active !== 'boolean' ||
                lease.source_key !== `enemy:${a.generation}:${pack}` ||
                published?.runtimeEpoch !== b.runtimeEpoch ||
                published.pack_id !== pack ||
                definition?.pack_id !== pack ||
                definition.group_size !== a.packIds.length
            )
                return null
            return {
                active: lease.active,
                terminal:
                    dead?.generation === a.generation &&
                    dead.pack_id === pack &&
                    dead.hp === 0 &&
                    dead.alive_state === 1 &&
                    !dead.captured,
            }
        })
        if (members.some((v) => !v)) continue
        const terminal = members.every((v) => v.terminal)
        if (!terminal && !members.some((v) => v.active)) continue
        if (s.worldObjects?.[map + ':' + objectId]?.complete && !terminal) continue
        const owner = taskOwner(c.tables, s, m, row, terminal)
        if (owner)
            sources.push({
                origin: 'LOCAL_CLIENT_CONTRACT',
                map_id: map,
                object_id: objectId,
                battle_fsm_type: group.battleFsmType,
                generation: a.generation,
                runtime_epoch: b.runtimeEpoch,
                ...owner,
                asset_sha256: binding.assetSha256,
                time: c.now,
            })
    }
    ensure(sources.length <= 1, 'Battle-message runtime source is ambiguous', ErrorCode.GameConfig)
    return sources[0] ?? null
}
export function recordBattleMessage(c, request) {
    if (request.key !== 61009) return false
    ensure(
        Array.isArray(request.args) && request.args.length === 2 && known.has(request.args[0]) && request.args[1] === 1,
        'Battle message does not match its current producer',
        ErrorCode.InvalidArgument,
    )
    const id = request.args[0]
    if (battleMessageCount(c.state, id) === 1) return true // Permanent fact; valid replay need not recreate the old scene.
    const proof = resolveSource(c, id)
    ensure(proof, 'Battle-message producer source is not currently declared', ErrorCode.InvalidTarget)
    const p = progress(c.state) ?? { version: 1, values: {}, sources: {} }
    c.state.battleMessageProgress = {
        version: 1,
        values: { ...p.values, [id]: 1 },
        sources: { ...p.sources, [id]: proof },
    }
    return true
}
