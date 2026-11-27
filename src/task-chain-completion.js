import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskPackageEligible } from './task-package-scope.js'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff

// DungeonTaskRuntime uses the declared chain when no global end predicate is
// supplied. This does not make an arbitrary empty victory condition a win.
export function currentEmptyVictoryTaskChain(tables, dungeonId) {
    const dungeon = tables.find('dungeon', dungeonId)
    if (dungeon?.victoryCondition !== '') return null
    const mappings = tables.get('dungeon_task').filter((row) => row.dungeonId === dungeonId)
    ensure(mappings.length <= 1, 'Dungeon task mapping is duplicated', ErrorCode.GameConfig)
    const mapping = mappings[0]
    if (!mapping || mapping.autoExit !== 1) return null
    ensure(
        typeof mapping.taskIds === 'string' && /^\d+(?:\|\d+)*$/.test(mapping.taskIds),
        'Dungeon task chain is malformed',
        ErrorCode.GameConfig,
    )
    const ids = mapping.taskIds.split('|').map(Number)
    ensure(
        ids.length > 0 && ids.every(positive) && new Set(ids).size === ids.length,
        'Dungeon task chain identities are malformed',
        ErrorCode.GameConfig,
    )
    for (const id of ids) {
        const task = tables.find('task', id)
        ensure(task, 'Dungeon task configuration is missing', ErrorCode.GameConfig)
        ensure(taskPackageEligible(task), 'Dungeon task package is unavailable', ErrorCode.FunctionClosed)
    }
    return ids
}

export function currentTaskChainFinished(tables, state, run) {
    const ids = currentEmptyVictoryTaskChain(tables, run?.dungeon_id)
    if (!ids || !Array.isArray(run?.task_ids) || run.task_ids.length !== ids.length) return false
    if (!ids.every((id, index) => id === run.task_ids[index])) return false
    if (![2, 3].includes(run.status)) return false
    if ((state.tasks ?? []).some((task) => ids.includes(task.task_id))) return false
    // CampaignCreate clears these per-run records before accepting the first
    // unfinished task. TaskFinish only writes them after its real node checks;
    // historical clear counts and response receipts are not current-run wins.
    return ids.every((id) => (state.taskRecords ?? []).some((record) => record.task_id === id && record.count > 0))
}
