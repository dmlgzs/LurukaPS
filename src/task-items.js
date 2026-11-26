import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskActionData } from './task-action-data.js'

export function taskItemCount(state, id) {
    return state.taskItems?.find((item) => item.item_id === id)?.item_num ?? 0
}

export function changeTaskItem(tables, state, id, delta) {
    ensure(tables.find('task_item', id), 'Unknown task item', ErrorCode.TaskItemConf)
    const count = taskItemCount(state, id) + delta
    ensure(
        Number.isSafeInteger(delta) && Number.isSafeInteger(count) && count >= 0 && count <= 99,
        delta < 0 ? 'Insufficient task items' : 'Task item quantity overflow',
    )
    state.taskItems = [
        ...(state.taskItems ?? []).filter((item) => item.item_id !== id),
        { item_id: id, item_num: count },
    ]
    state.taskItemRevision = (state.taskItemRevision ?? 0) + 1
}

export function taskItemSnapshot(state) {
    return {
        task_items: (state.taskItems ?? []).filter((item) => item.item_num > 0),
        del_task_items: (state.taskItems ?? []).filter((item) => item.item_num === 0).map((item) => item.item_id),
    }
}

const list = (value) => (value == null ? [] : [value].flat())
const actionKey = (state, taskId, nodeId, phase, index) =>
    `${taskId}:${state.taskEpochs?.[taskId] ?? 0}:${nodeId}:${phase}:${index}`

function itemActions(config, phase) {
    const node = config?.__type_TaskConditionNodeData ?? config
    return list(node?.[phase === 'before' ? 'beforActionList' : 'afterActionList']).flatMap((action, index) => {
        if (![1300, 1500].includes(action.contentType)) return []
        // The CBT3 exporter names the creation subtype "bagType".
        const payload = taskActionData(action)
        const data =
            action.contentType === 1300
                ? (payload.__type_TaskCreatItemData ?? payload.bagType)
                : payload.__type_TaskDeleteItemData
        ensure(
            data && Number.isInteger(data.itemId) && Number.isInteger(data.itemCount) && data.itemCount > 0,
            'Invalid task item action',
            ErrorCode.GameConfig,
        )
        return [{ index, data, create: action.contentType === 1300 }]
    })
}

export function applyTaskItemActions(tables, state, taskId, nodeId, config, phase) {
    for (const action of itemActions(config, phase)) {
        const key = actionKey(state, taskId, nodeId, phase, action.index)
        if (state.taskItemActionReceipts?.[key]) continue
        // bagType 5 is a task bag, not resource type 5 (which creates pets).
        // Old exports also leave bagType at 0; validate the task_item table.
        const { itemId, itemCount } = action.data
        const delta = action.create ? itemCount : -Math.min(itemCount, taskItemCount(state, itemId))
        if (delta) changeTaskItem(tables, state, itemId, delta)
        ;(state.taskItemActionReceipts ??= {})[key] = { item_id: itemId, delta }
    }
}

export function recoverMissingTaskItems(tables, graphs, state) {
    for (const task of state.tasks ?? []) {
        const graph = graphs.get(task.task_id),
            needed = new Set()
        for (const node of task.nodes) {
            for (const condition of list(graph.nodes.get(node.node_id)?.__type_TaskConditionNodeData?.conditionList)) {
                const data = condition.__type_TaskConditionBaseData?.__type_TaskCondSubItemData
                if (condition.conditionId !== 2501 || data?.itemBigType !== 20) continue
                for (const item of list(data.itemDatas)) needed.add(item.itemId)
            }
        }
        for (const id of needed) {
            const receipts = [],
                epoch = state.taskEpochs?.[task.task_id] ?? 0
            let expected = 0
            for (const nodeId of task.finish_nodes)
                for (const phase of ['before', 'after']) {
                    for (const action of itemActions(graph.nodes.get(nodeId), phase)) {
                        if (action.data.itemId !== id) continue
                        expected = action.create
                            ? expected + action.data.itemCount
                            : Math.max(0, expected - action.data.itemCount)
                        receipts.push(actionKey(state, task.task_id, nodeId, phase, action.index))
                    }
                }
            // Recover only an unrecorded creation proven by completed nodes,
            // accounting for submissions already made in this task epoch.
            if (!receipts.length || receipts.some((key) => state.taskItemActionReceipts?.[key])) continue
            for (const [key, record] of Object.entries(state.taskDeliveries ?? {}))
                if (key.startsWith(`${task.task_id}:${epoch}:`)) expected -= record[`20:${id}`] ?? 0
            const missing = Math.max(0, expected - taskItemCount(state, id))
            if (missing) changeTaskItem(tables, state, id, missing)
            for (const key of receipts) (state.taskItemActionReceipts ??= {})[key] = { item_id: id, recovered: true }
        }
    }
}
