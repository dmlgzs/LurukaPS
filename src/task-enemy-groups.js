import { TaskGraphs, asList } from './tasks.js'
import { taskOverrideNodeIds } from './task-action-data.js'
const catalogs = new WeakMap()
export function taskEnemyGroups(tables, state) {
    let catalog = catalogs.get(tables)
    if (!catalog) catalogs.set(tables, (catalog = { graphs: new TaskGraphs(tables) }))
    const signature =
        state.world.map_id +
        ':' +
        (state.tasks ?? [])
            .map((task) => task.task_id + '=' + task.nodes.map((node) => node.node_id).join(','))
            .join(';')
    if (catalog.signature === signature) return catalog.groups
    const graphs = catalog.graphs
    const groups = []
    for (const task of state.tasks ?? []) {
        const graph = graphs.get(task.task_id),
            nodes = new Set(task.nodes.map((node) => node.node_id))
        for (const [controllerIndex, controller] of graph.controllers.entries()) {
            if (!taskOverrideNodeIds(controller).some((id) => nodes.has(id))) continue
            for (const data of asList(controller.__type_TaskCreateBattleUnitDataController?.enemiesDatas)) {
                const groupId = data?.__type_TaskEnemiesOverrideData?.enemiesGroupId
                if (!groupId || data.sceneId !== state.world.map_id) continue
                groups.push({
                    groupId,
                    objectId: data.createNpcId,
                    taskConfig: graph.config,
                    data,
                    taskId: task.task_id,
                    controllerIndex,
                })
            }
        }
    }
    catalog.signature = signature
    return (catalog.groups = groups)
}
