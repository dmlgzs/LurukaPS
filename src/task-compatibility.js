import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskPackageEligible } from './task-package-scope.js'

// Identity-only source boundary, never a source of graph/action/reward data.
// Historical CBT3 task export:146 IDs, sorted-ID SHA256
// 2a738820a277a9310c3afaab572d485f050a312cbaeab5f943fc0520f2cf77ef.
const historicalIds = new Set([
    ...Array.from({ length: 48 }, (_, index) => 100000 + index),
    104001,
    104002,
    104003,
    104004,
    104005,
    104006,
    104007,
    104008,
    104009,
    104010,
    106001,
    106002,
    106009,
    106010,
    106012,
    106013,
    106014,
    106015,
    106016,
    106017,
    106018,
    106019,
    106020,
    106021,
    106022,
    106027,
    107016,
    108016,
    202005,
    202007,
    202015,
    202025,
    203003,
    204003,
    204004,
    204010,
    206001,
    206011,
    206021,
    206022,
    206035,
    206036,
    206037,
    206038,
    206044,
    206045,
    206046,
    208007,
    208013,
    212005,
    213003,
    213004,
    213009,
    214001,
    214002,
    214004,
    216004,
    216005,
    216006,
    216007,
    216008,
    216011,
    218001,
    323001,
    323002,
    400001,
    400101,
    400102,
    400103,
    400104,
    400105,
    400106,
    400107,
    400108,
    400109,
    400110,
    400111,
    400201,
    400202,
    400203,
    403002,
    404001,
    404002,
    500002,
    500011,
    500012,
    500013,
    500014,
    500015,
    500016,
    500017,
    500018,
    806005,
    806006,
    806007,
    990201,
    996001,
    996002,
])
const currentSignature = 'fd3e2324d13e44db130c6309091538ce26d00728209eb20041678ba1eb2acf0c'
export function currentTaskAvailable(tables, id) {
    ensure(Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff, 'Invalid saved task identity', ErrorCode.GameConfig)
    if (tables.find('task', id)) return true
    const ids = tables
        .get('task')
        .map((row) => row.id)
        .sort((a, b) => a - b)
    ensure(
        historicalIds.has(id) && createHash('sha256').update(JSON.stringify(ids)).digest('hex') === currentSignature,
        `Unknown saved task ${id}`,
        ErrorCode.TaskConfFail,
    )
    return false
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

// Persisted references only. RPC validation never invokes this migration.
// A loaded graph's node-ID membership is authoritative; DFS reachability is not.
export function unavailableTaskNodeIds(graph, task) {
    ensure(
        object(task) &&
            positive(task.task_id) &&
            graph?.config?.id === task.task_id &&
            graph.nodes instanceof Map &&
            Array.isArray(task.nodes),
        'Persisted task graph references are malformed',
        ErrorCode.GameConfig,
    )
    const refs = []
    for (const node of task.nodes) {
        ensure(object(node) && positive(node.node_id), 'Persisted active task node is malformed', ErrorCode.GameConfig)
        refs.push(node.node_id)
    }
    for (const field of ['finish_nodes', 'reward_nodes']) {
        if (task[field] === undefined) continue
        ensure(
            Array.isArray(task[field]) && task[field].every(positive),
            'Persisted task node history is malformed',
            ErrorCode.GameConfig,
        )
        refs.push(...task[field])
    }
    return [...new Set(refs.filter((id) => !graph.nodes.has(id)))].sort((a, b) => a - b)
}

export function suspendUnavailableTasks(tables, state, graphs) {
    ensure(Array.isArray(state.tasks ?? []), 'Active task roster is malformed', ErrorCode.GameConfig)
    // Validate and load the whole roster before any archive/writeback. In
    // particular, missing files, bad JSON and invalid current graphs propagate.
    const suspended = [],
        seen = new Set()
    for (const task of state.tasks ?? []) {
        ensure(
            object(task) && positive(task.task_id) && !seen.has(task.task_id),
            'Active task identity is malformed',
            ErrorCode.GameConfig,
        )
        seen.add(task.task_id)
        if (!currentTaskAvailable(tables, task.task_id)) {
            suspended.push({ task, reason: 'unavailableCurrentTask' })
            continue
        }
        if (!graphs || !taskPackageEligible(tables.find('task', task.task_id))) continue
        const graph = graphs.get(task.task_id)
        const missingNodeIds = unavailableTaskNodeIds(graph, task)
        if (missingNodeIds.length) suspended.push({ task, reason: 'unavailableCurrentTaskNode', missingNodeIds })
    }
    if (!suspended.length) return []
    ensure(
        state.compatibilityDiagnostics === undefined || object(state.compatibilityDiagnostics),
        'Compatibility diagnostics are malformed',
        ErrorCode.GameConfig,
    )
    const original = state.compatibilityDiagnostics?.suspendedTasks
    ensure(original === undefined || object(original), 'Suspended task archive is malformed', ErrorCode.GameConfig)
    const archive = structuredClone(original ?? {}),
        ids = new Set(suspended.map(({ task }) => task.task_id))
    const removePending = new Set()
    for (const { task, reason, missingNodeIds } of suspended) {
        const epoch = state.taskEpochs?.[task.task_id] ?? 0
        ensure(uint(epoch), 'Persisted task epoch is malformed', ErrorCode.GameConfig)
        const key = `${task.task_id}:${epoch}`
        ensure(
            archive[key] === undefined ||
                (object(archive[key]) && JSON.stringify(archive[key].task) === JSON.stringify(task)),
            'Conflicting suspended task progress',
            ErrorCode.GameConfig,
        )
        archive[key] ??= {
            version: '1.0.0',
            reason,
            task: structuredClone(task),
            ...(missingNodeIds ? { missingNodeIds, nodeSource: 'unidentified-persistent-reference' } : {}),
        }
        for (const field of ['pendingTaskStorySync', 'pendingTaskScene', 'pendingCharacterTask']) {
            const pending = state[field]
            if (pending?.task_id !== task.task_id || (pending.epoch !== undefined && pending.epoch !== epoch)) continue
            archive[key][field] ??= structuredClone(pending)
            removePending.add(field)
        }
        const trace = state.taskTraceChoices?.[key]
        if (trace !== undefined) archive[key].traceChoice ??= structuredClone(trace)
    }
    const barrier = state.pendingTaskStorySync,
        extraIds = barrier?.extra?.new_task_ids
    let keptHints
    if (!removePending.has('pendingTaskStorySync') && extraIds !== undefined) {
        ensure(
            Array.isArray(extraIds) && extraIds.every(positive),
            'Pending task notification IDs are malformed',
            ErrorCode.GameConfig,
        )
        if (extraIds.some((id) => ids.has(id))) {
            ensure(positive(barrier.task_id), 'Pending story task owner is malformed', ErrorCode.GameConfig)
            keptHints = extraIds.filter((id) => !ids.has(id))
            for (const { task } of suspended) {
                if (!extraIds.includes(task.task_id)) continue
                const key = `${task.task_id}:${state.taskEpochs?.[task.task_id] ?? 0}`
                archive[key].pendingStoryHint ??= {
                    field: 'pendingTaskStorySync.extra.new_task_ids',
                    ownerTaskId: barrier.task_id,
                    rawTaskIds: structuredClone(extraIds),
                }
            }
        }
    }
    state.compatibilityDiagnostics ??= {}
    state.compatibilityDiagnostics.suspendedTasks = archive
    // All complete/reward/delivery/trace/epoch ledgers remain unchanged. The
    // archived instance never grants a replacement node or completion fact.
    state.tasks = state.tasks.filter((task) => !ids.has(task.task_id))
    for (const field of removePending) delete state[field]
    if (keptHints) state.pendingTaskStorySync = { ...barrier, extra: { ...barrier.extra, new_task_ids: keptHints } }
    return [...ids]
}

export function suspendedTaskIds(state) {
    const active = new Set((state.tasks ?? []).map((task) => task.task_id))
    return [
        ...new Set(
            Object.values(state.compatibilityDiagnostics?.suspendedTasks ?? {}).map((entry) => entry.task.task_id),
        ),
    ].filter((id) => !active.has(id))
}
