import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

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

export function suspendUnavailableTasks(tables, state) {
    // Validate the whole active roster before changing any of its entries.
    const suspended = (state.tasks ?? []).filter((task) => !currentTaskAvailable(tables, task.task_id))
    if (!suspended.length) return []
    state.compatibilityDiagnostics ??= {}
    const archive = (state.compatibilityDiagnostics.suspendedTasks ??= {})
    const ids = new Set(suspended.map((task) => task.task_id))
    for (const task of suspended) {
        const epoch = state.taskEpochs?.[task.task_id] ?? 0
        const key = `${task.task_id}:${epoch}`
        ensure(
            !archive[key] || JSON.stringify(archive[key].task) === JSON.stringify(task),
            'Conflicting suspended task progress',
            ErrorCode.GameConfig,
        )
        archive[key] ??= { version: '1.0.0', reason: 'unavailableCurrentTask', task: structuredClone(task) }
        for (const field of ['pendingTaskStorySync', 'pendingTaskScene', 'pendingCharacterTask']) {
            if (state[field]?.task_id !== task.task_id) continue
            archive[key][field] ??= structuredClone(state[field])
            delete state[field]
        }
    }
    // Finished/reward/delivery/epoch facts remain in their original ledgers;
    // full active-node progress is retained verbatim in the archive above.
    state.tasks = state.tasks.filter((task) => !ids.has(task.task_id))
    return [...ids]
}

export function suspendedTaskIds(state) {
    return [
        ...new Set(
            Object.values(state.compatibilityDiagnostics?.suspendedTasks ?? {}).map((entry) => entry.task.task_id),
        ),
    ]
}
