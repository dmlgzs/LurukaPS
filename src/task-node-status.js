import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// 1.0 CheckTaskNodeIsFinished0602f31d checks the active attempt first.
// Callers validate condition arguments; this leaf reads no graphs and changes no state.
export function taskNodeFinishedCurrentAttempt(state, taskId, nodeId) {
    const tasks = state.tasks ?? []
    ensure(Array.isArray(tasks), 'Invalid active task state', ErrorCode.GameConfig)
    const task = tasks.find((entry) => entry.task_id === taskId)
    if (task) {
        const finished = task.finish_nodes ?? []
        ensure(
            Array.isArray(finished) && finished.every((node) => Number.isSafeInteger(node) && node >= 0),
            'Invalid finished task nodes',
            ErrorCode.GameConfig,
        )
        return finished.includes(nodeId)
    }
    const records = state.taskRecords ?? []
    ensure(Array.isArray(records), 'Invalid task completion records', ErrorCode.GameConfig)
    const record = records.find((entry) => entry.task_id === taskId)
    if (!record) return false
    ensure(
        Number.isSafeInteger(record.count) && record.count >= 0,
        'Invalid task completion count',
        ErrorCode.GameConfig,
    )
    // Positive counts are this server's saved completion facts. The current
    // client stores completed task IDs, rather than comparing TaskRecord.count.
    return record.count > 0
}
