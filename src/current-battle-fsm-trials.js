import index from '../configs/current-battle-fsm-trials.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { resolveCurrentTrialGroup } from './current-scene-trials.js'
import { WorldObjectCatalog } from './world-objects.js'
import { enemyDefinition } from './enemy-state.js'
import { TaskGraphs, nodeConditions } from './tasks.js'
import { taskPackageEligible } from './task-package-scope.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    positive = (value) => uint(value) && value > 0,
    hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    models = new WeakMap()
export function validateBattleFsmTrialIndex(source = index) {
    ensure(
        source?.schemaVersion === 1 &&
            source.clientVersion === '1.0.0' &&
            source.packageVersion === '3217420' &&
            source.origin === 'CURRENT_CLIENT_STATIC' &&
            hash(source.provenance?.globalAssetSha256) &&
            hash(source.provenance?.manifestSha256) &&
            Array.isArray(source.fsms) &&
            source.fsms.length > 0,
        'Current battle-FSM trial index is malformed',
        ErrorCode.GameConfig,
    )
    const rows = new Map()
    for (const row of source.fsms) {
        ensure(
            uint(row.id) &&
                !rows.has(row.id) &&
                typeof row.path === 'string' &&
                row.path.startsWith('Config/') &&
                ['parsed', 'missing-current-asset'].includes(row.status) &&
                Array.isArray(row.trialRefs),
            'Current battle-FSM trial binding is malformed',
            ErrorCode.GameConfig,
        )
        if (row.status === 'parsed') {
            ensure(
                hash(row.assetSha256) &&
                    hash(row.graphSha256) &&
                    Array.isArray(row.trialIds) &&
                    row.trialIds.every(positive) &&
                    new Set(row.trialIds).size === row.trialIds.length,
                'Current battle-FSM trial references are malformed',
                ErrorCode.GameConfig,
            )
            ensure(
                row.trialRefs.every(
                    (ref) =>
                        uint(ref.trialId) &&
                        typeof ref.isOn === 'boolean' &&
                        typeof ref.enabled === 'boolean' &&
                        typeof ref.path === 'string',
                ),
                'Current battle-FSM typed action is malformed',
                ErrorCode.GameConfig,
            )
            const actual = [
                ...new Set(
                    row.trialRefs.filter((ref) => ref.enabled && ref.isOn && ref.trialId > 0).map((ref) => ref.trialId),
                ),
            ].sort((a, b) => a - b)
            ensure(
                JSON.stringify(actual) === JSON.stringify([...row.trialIds].sort((a, b) => a - b)),
                'Current battle-FSM trial references disagree with typed actions',
                ErrorCode.GameConfig,
            )
        }
        rows.set(row.id, row)
    }
    return rows
}
const bindings = validateBattleFsmTrialIndex()
function model(tables) {
    let value = models.get(tables)
    if (!value) models.set(tables, (value = { world: new WorldObjectCatalog(tables), graphs: new TaskGraphs(tables) }))
    return value
}
function targetSource(tables, state, catalog, row, terminal) {
    const matches = []
    for (const task of state.tasks ?? []) {
        const graph = catalog.graphs.get(task.task_id)
        if (!taskPackageEligible(graph.config)) continue
        const live = task.nodes.filter((node) => !task.finish_nodes?.includes(node.node_id)),
            sources = live.map((node) => ({ node, declared: graph.nodes.get(node.node_id), successorNodeIds: [] }))
        // Completion of a goal is not completion of its independent client
        // battle FSM. Keep the issued terminal source through its actual
        // immediate task successors, not every later node or task history.
        if (terminal)
            for (const id of task.finish_nodes ?? []) {
                const declared = graph.nodes.get(id)
                if (!declared) continue
                const successors = live.filter((node) => declared.nextNodeIdList?.includes(node.node_id))
                if (successors.length)
                    sources.push({ node: null, declared, successorNodeIds: successors.map((node) => node.node_id) })
            }
        for (const { node, declared, successorNodeIds } of sources) {
            ensure(declared, 'Battle-FSM trial source task node is missing', ErrorCode.TaskNoNodeId)
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
                        'Battle-FSM trial source task progress is malformed',
                        ErrorCode.GameConfig,
                    )
                    if (!terminal && (node.node_values[index] >= 1 || node.client_cond_after?.[index] === true))
                        continue
                    if (terminal && node.node_values[index] > 1) continue
                }
                matches.push({ taskId: task.task_id, nodeId: declared.id, index, successorNodeIds })
            }
        }
    }
    ensure(matches.length <= 1, 'Battle-FSM trial source task authority is ambiguous', ErrorCode.GameConfig)
    return matches[0] ?? null
}

// LOCAL admission from exact current client FSM references and server-issued
// world presentation facts. This is not a client-reported FSM instruction ptr.
// The initial supported source is a current typed task/world battle target;
// scene-only or arbitrary historical battles do not acquire a new authority.
export function currentBattleFsmTrialAdmission(tables, state, groupId) {
    const battle = state.combat,
        leases = state.worldObjectAoi,
        map = state.world?.map_id
    if (leases !== undefined)
        ensure(
            leases && leases.version === 1 && hash(leases.connection_hash),
            'Battle-FSM trial presence ledger is malformed',
            ErrorCode.GameConfig,
        )
    if (
        !battle ||
        battle.map_id !== map ||
        !positive(battle.runtimeEpoch) ||
        leases?.scene?.map_id !== map ||
        leases.scene.runtime_epoch !== battle.runtimeEpoch
    )
        return null
    ensure(
        leases.agents && typeof leases.agents === 'object' && !Array.isArray(leases.agents),
        'Battle-FSM trial source lease ledger is malformed',
        ErrorCode.GameConfig,
    )
    const catalog = model(tables),
        candidates = []
    for (const [root, activation] of Object.entries(battle.enemyActivations ?? {})) {
        ensure(
            /^[1-9]\d*$/.test(root) && BigInt(root) <= 0xffffffffffffffffn,
            'Battle-FSM trial activation identity is malformed',
            ErrorCode.GameConfig,
        )
        const uuid = BigInt(root)
        if (uuid >> 56n !== 3n || ((uuid >> 32n) & 0xffffffn) !== 0n) continue
        ensure(
            activation &&
                positive(activation.generation) &&
                typeof activation.active === 'boolean' &&
                Array.isArray(activation.packIds) &&
                activation.packIds.length > 0 &&
                activation.packIds.length <= 256 &&
                activation.packIds.every(positive),
            'Battle-FSM enemy activation is malformed',
            ErrorCode.GameConfig,
        )
        if (!activation.active) continue // Explicit source revocation is not a mere lease release or HP0.
        const objectId = Number(uuid & 0xffffffffn),
            row = catalog.world.find('worldmap_' + map, objectId)
        if (!row || row.cityId !== map || tables.find('world_spawner', row.spawnerId)?.objectType !== 50) continue
        const group = tables.find('world_enemy_group', row.expandId)
        ensure(group, 'Battle-FSM enemy group configuration is missing', ErrorCode.GameConfig)
        const binding = bindings.get(group.battleFsmType)
        if (!binding) continue
        if (binding.status !== 'parsed') {
            // A globally referenced but absent current asset is never treated
            // as a proven empty set. Only a relevant declared target errors.
            if (targetSource(tables, state, catalog, row, false))
                ensure(false, 'Current bound battle FSM asset is unavailable', ErrorCode.GameConfig)
            continue
        }
        if (!binding.trialIds.includes(groupId)) continue
        const record = state.worldObjects?.[map + ':' + objectId]
        if (record?.active === false) continue
        const members = activation.packIds.map((packId, slot) => {
            const id = (uuid | (BigInt(slot) << 32n)).toString(),
                receipt = leases.agents[id],
                published = state.combatEnemyPresentations?.[map]?.[id],
                terminal = battle.enemyTerminals?.[id]
            if (
                !receipt ||
                typeof receipt.active !== 'boolean' ||
                receipt.source_key !== `enemy:${activation.generation}:${packId}` ||
                published?.runtimeEpoch !== battle.runtimeEpoch ||
                published.pack_id !== packId
            )
                return null
            const definition = enemyDefinition(tables, state, id)
            if (!definition || definition.pack_id !== packId || definition.group_size !== activation.packIds.length)
                return null
            return {
                active: receipt.active,
                terminal:
                    terminal?.generation === activation.generation &&
                    terminal.pack_id === packId &&
                    terminal.hp === 0 &&
                    terminal.alive_state === 1 &&
                    !terminal.captured,
            }
        })
        if (members.some((member) => !member)) continue
        const terminal = members.every((member) => member.terminal),
            active = activation.active && members.some((member) => member.active)
        if (!active && !terminal) continue
        if (record?.complete && !terminal) continue
        const owner = targetSource(tables, state, catalog, row, terminal)
        if (!owner) continue
        candidates.push({
            ...owner,
            mapId: map,
            objectId,
            enemyGroupId: group.id,
            battleFsmType: group.battleFsmType,
            generation: activation.generation,
            runtimeEpoch: battle.runtimeEpoch,
            terminalCleanup: terminal,
        })
    }
    ensure(
        candidates.length <= 1,
        'Multiple current battle FSMs request an ambiguous trial template',
        ErrorCode.GameConfig,
    )
    if (!candidates.length) return null
    const source = candidates[0]
    return {
        roster: resolveCurrentTrialGroup(tables, groupId),
        source: 'battle-fsm',
        taskId: source.taskId,
        battleFsmSource: source,
    }
}
