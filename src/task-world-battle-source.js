import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { TaskGraphs, nodeConditions } from './tasks.js'
import { taskPackageEligible } from './task-package-scope.js'

const graphs = new WeakMap()

function conditionSceneMatches(tables, state, taskId, sceneId) {
    if (sceneId === state.world.map_id) return true
    const run = state.storyCampaign
    // Same limited zero-scene binding as refreshTaskProgress's2500 witness.
    if (
        sceneId !== 0 ||
        run?.status !== 2 ||
        run.map_id !== state.world.map_id ||
        !Array.isArray(run.scenes) ||
        !run.scenes.includes(state.world.map_id) ||
        !Array.isArray(run.task_ids) ||
        !run.task_ids.includes(taskId)
    )
        return false
    const mapping = tables.get('dungeon_task').find((row) => row.dungeonId === run.dungeon_id)
    return String(mapping?.taskIds ?? '')
        .split('|')
        .map(Number)
        .includes(taskId)
}

// LOCAL admission derived from the current typed task target. Native2500
// executes StepOver, not a server-active write. Scene AOI can request this
// target while the node's Before story is still playing, before9861 arrives.
// This never acknowledges Before, completes a goal,
// mutates world records, or changes the ordinary search visibility predicate.
export function activeTaskWorldBattleSource(tables, state, row) {
    if (row.cityId !== state.world.map_id || tables.find('world_spawner', row.spawnerId)?.objectType !== 50) return null
    let catalog = graphs.get(tables)
    if (!catalog) graphs.set(tables, (catalog = new TaskGraphs(tables)))
    for (const task of state.tasks ?? []) {
        const graph = catalog.get(task.task_id)
        if (!taskPackageEligible(graph.config)) continue
        for (const node of task.nodes) {
            if (task.finish_nodes?.includes(node.node_id)) continue
            const declared = graph.nodes.get(node.node_id)
            ensure(declared, 'Task world battle target node is unavailable', ErrorCode.TaskNoNodeId)
            const conditions = nodeConditions(declared)
            for (const [index, condition] of conditions.entries()) {
                const base = condition.__type_TaskConditionBaseData,
                    data = base?.__type_TaskCondBattleTriggerData
                if (
                    condition.conditionId !== 2500 ||
                    data?.checkNameType !== 5 ||
                    data.count !== 1 ||
                    data.npcId !== row.id ||
                    !conditionSceneMatches(tables, state, task.task_id, base.mapData?.sceneId)
                )
                    continue
                ensure(
                    Array.isArray(node.node_values) &&
                        Number.isSafeInteger(node.node_values[index]) &&
                        node.node_values[index] >= 0,
                    'Task world battle target progress is malformed',
                    ErrorCode.GameConfig,
                )
                if (node.node_values[index] >= 1 || node.client_cond_after?.[index] === true) continue
                return { task_id: task.task_id, node_id: node.node_id, index, map_id: row.cityId, object_id: row.id }
            }
        }
    }
    return null
}
