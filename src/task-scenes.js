import { ErrorCode } from './error-codes.js'
import { TaskGraphs, asList } from './tasks.js'
import { ensure } from './handlers/common.js'
const graphsByTables = new WeakMap()
function catalog(tables) {
    let graphs = graphsByTables.get(tables)
    if (!graphs) {
        graphs = new TaskGraphs(tables)
        graphsByTables.set(tables, graphs)
    }
    return graphs
}
export function taskActions(node, phase = 'before') {
    const data =
        node.__type_TaskConditionNodeData ??
        node.__type_TaskConditonBranchNodeData ??
        node.__type_TaskActionNodeData ??
        node.__type_TaskEndExportData ??
        {}
    return asList(phase === 'before' ? (data.beforActionList ?? data.actionList) : data.afterActionList).map(
        (a) => a.dataType ?? {},
    )
}
export function taskBirthPoint(tables, id, map) {
    const points = tables.get('world_borthpos')
    const point = id ? points.find((p) => p.id === id) : points.find((p) => p.cityId === map && p.mainPoint === 1)
    ensure(point && (!map || point.cityId === map), 'Task scene birth point unavailable', ErrorCode.NotFoundBirthPoint)
    return point
}
export function moveTaskScene(tables, state, point, remember = true) {
    if (remember && state.world.map_id !== point.cityId) {
        const w = state.world,
            history = (state.worldHistory ??= [])
        history.push({ map_id: w.map_id, area_id: w.area_id, pos: { ...w.pos }, angle: w.angle })
        if (history.length > 8) history.shift()
    }
    Object.assign(state.world, tables.position(point))
}
// Server-side TeamChange has no network request in CBT3. Apply once per node
// before the client starts its story queue. Legacy wrong-scene saves recover here.
export function prepareTaskScenes(tables, state, { login = false } = {}) {
    const graphs = catalog(tables),
        receipts = (state.taskSceneReceipts ??= {})
    let changed = false
    for (const task of state.tasks ?? []) {
        if (tables.find('task', task.task_id)?.type !== 1) continue
        for (const node of task.nodes) {
            const key = `${task.task_id}:${state.taskEpochs?.[task.task_id] ?? 0}:${node.node_id}`
            if (receipts[key]) continue
            const graph = graphs.get(task.task_id),
                config = graph.nodes.get(node.node_id),
                actions = taskActions(config)
            const afterTransfers = taskActions(config, 'after')
                .map((a) => a.__type_TaskTransferBaseData?.transferPointId)
                .filter(Boolean)
            if (
                node.client_before &&
                afterTransfers.some((id) => tables.find('world_borthpos', id)?.cityId === state.world.map_id)
            ) {
                // The client can transfer during After before reporting the
                // node complete. A missing legacy receipt must not rewind it
                // to the earlier Before scene on login or the next request.
                receipts[key] = true
                continue
            }
            const team = actions.find((a) => a.__type_TaskTeamChangeData?.changeScene > 0)?.__type_TaskTeamChangeData
            const transfers = actions.map((a) => a.__type_TaskTransferBaseData).filter((a) => a?.transferPointId > 0)
            // Multi-transfer story nodes must run their configured scene/story
            // sequence in order on the client. Prepositioning at the first point
            // can leave the rest of that sequence in the same scene.
            const transfer = transfers.length === 1 ? transfers[0] : null
            let point
            if (team) point = taskBirthPoint(tables, 0, team.changeScene)
            else if (node.client_before && transfer) point = taskBirthPoint(tables, transfer.transferPointId)
            else if (
                login &&
                graph.controllers.some(
                    (c) => c.__type_TaskTeamController && asList(c.field_530003).includes(node.node_id),
                )
            ) {
                const checkpoint = graph.transports
                    .map((x) => x.__type_TaskNodeTransposData)
                    .find((d) => d && asList(d.taskKeepList).includes(node.node_id))
                if (checkpoint) point = taskBirthPoint(tables, checkpoint.transPoint)
            }
            if (!point) continue
            if (state.world.map_id !== point.cityId) {
                moveTaskScene(tables, state, point, !login)
                if (login)
                    state.pendingTaskScene = {
                        task_id: task.task_id,
                        node_id: node.node_id,
                        point_id: point.id,
                        map_id: point.cityId,
                    }
                changed = true
            }
            receipts[key] = true
        }
    }
    return changed
}
export function validateTaskTransfer(tables, state, r) {
    if (!r.task_id && !r.node_id) return null
    const task = state.tasks.find((t) => t.task_id === r.task_id),
        node = task?.nodes.find((n) => n.node_id === r.node_id)
    ensure(node, 'Task transfer node is not active')
    const config = catalog(tables).get(r.task_id).nodes.get(r.node_id)
    const allowed = [...taskActions(config), ...taskActions(config, 'after')]
        .map((a) => a.__type_TaskTransferBaseData?.transferPointId)
        .filter(Boolean)
    ensure(allowed.includes(r.point_id), 'Task transfer point is not configured')
    return taskBirthPoint(tables, r.point_id, r.map_id)
}
