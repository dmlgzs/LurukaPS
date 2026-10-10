import { rewardSource } from '../reward-source.js'
import { submitTaskItems, deliveryKey, deliveryComplete } from '../task-delivery.js'
import { applyTaskItemActions } from '../task-items.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { ensure } from './common.js'
import { WorldObjectCatalog } from '../world-objects.js'
import { advanceStoryCampaignTask } from './story-campaign.js'
import {
    TaskGraphs,
    activeTask,
    activeNode,
    makeNode,
    nodeConditions,
    conditionValue,
    asList,
    conditionSatisfied,
    taskUnlocked,
    acceptTask,
    taskSnapshot,
    advancePetChoiceBranch,
    deferTaskSyncUntilAfterStories,
    canRecoverClearedDungeonNode,
    reconcileClearedDungeonBefore,
} from '../tasks.js'
// Use the table distinction between whole-task and node completion.
const taskRewards = (tables, rewards, operation = 'taskNodeComplete') => ({
    rewards,
    src: rewardSource(tables, operation),
})
export function registerTasks(register, tables) {
    const handlers = new Map()
    const on = (name, fn) => {
        handlers.set(name, fn)
        register(name, fn)
    }
    const graphs = new TaskGraphs(tables)
    const drops = new WorldObjectCatalog(tables)
    const sync = (c, extra = {}, beforeReply = false) => {
        const barrier = c.state.pendingTaskStorySync
        if (barrier) {
            barrier.extra = { ...(barrier.extra ?? {}), ...extra }
            return
        }
        ;(beforeReply ? c.pushBefore : c.push)('CSProtoTaskSync', { ...taskSnapshot(tables, c.state), ...extra })
    }
    const current = (c, r) => {
        const graph = graphs.get(r.task_id),
            task = activeTask(c.state, r.task_id),
            node = activeNode(task, r.node_id)
        return { graph, task, node, config: graph.nodes.get(r.node_id) }
    }
    const finished = (c, r) => {
        const task = activeTask(c.state, r.task_id),
            graph = graphs.get(r.task_id)
        return graph.nodes.has(r.node_id) &&
            (task.finish_nodes.includes(r.node_id) || (r.node_id === graph.end && task.final_time))
            ? task
            : null
    }
    const rewardNode = (c, task, nodeId) => {
        task.reward_nodes ??= []
        if (task.reward_nodes.includes(nodeId)) return []
        const steps = tables
            .get('task_step')
            .filter((s) => s.taskId === task.task_id && s.nodeId === nodeId && s.reward)
        if (!steps.length) return []
        const rewards = grantRewards(
            tables,
            c.state,
            steps.flatMap((s) => drops.drops(s.reward, c.randomInt)),
        )
        task.reward_nodes.push(nodeId)
        c.pushBefore('CSProtoSyncPlayerData', c.state.player)
        return rewards
    }
    on('TaskAccept', (c, r) => {
        const g = graphs.get(r.u32)
        ensure(!c.state.tasks.some((t) => t.task_id === r.u32), 'Task already active')
        ensure(
            g.config.canRepeat === 1 || !(c.state.taskRecords || []).some((t) => t.task_id === r.u32 && t.count > 0),
            'Task already completed',
        )
        ensure(taskUnlocked(g, c.state, { tables, accepting: true }), `Task prerequisites not met (task ${r.u32})`)
        acceptTask(g, c.state, c.now)
        sync(c)
        return {}
    })
    on('TaskAbandon', (c, r) => {
        activeTask(c.state, r.u32)
        if (c.state.pendingTaskStorySync?.task_id === r.u32) delete c.state.pendingTaskStorySync
        c.state.tasks = c.state.tasks.filter((t) => t.task_id !== r.u32)
        sync(c, { del_tasks: [r.u32], del_trace_list: [r.u32] })
        return {}
    })
    on('TaskFinish', (c, r) => {
        const graph = graphs.get(r.u32),
            key = `${r.u32}:${c.state.taskEpochs?.[r.u32] ?? 0}`,
            task = c.state.tasks.find((t) => t.task_id === r.u32)
        if (!task) {
            const receipt = c.state.taskFinishReceipts?.[key]
            ensure(receipt, 'Task is not active')
            // The receipt proves delivery; replaying its contents creates a
            // second client reward presentation on a new retry request.
            return taskRewards(tables, [], 'taskComplete')
        }
        const end = graph.nodes.get(graph.end)
        ensure(
            end?.nodeType === 50 && task.nodes.some((n) => n.node_id === graph.end),
            'Task has not reached its acknowledged end node',
        )
        // CBT3 TaskEndNode0601ff10 directly requests TaskFinish once its local
        // actions finish; it never sends TaskClientAfter for the end node.
        task.final_time ??= c.now
        const rewards = grantRewards(tables, c.state, parseRewards(graph.config.taskReward))
        c.state.taskFinishReceipts ??= {}
        c.state.taskFinishReceipts[key] = rewards
        c.state.taskRecords ??= []
        let record = c.state.taskRecords.find((x) => x.task_id === r.u32)
        if (!record) {
            record = { task_id: r.u32, count: 0, time: 0 }
            c.state.taskRecords.push(record)
        }
        record.count++
        record.time = c.now
        c.state.tasks = c.state.tasks.filter((t) => t.task_id !== r.u32)
        advanceStoryCampaignTask(c, r.u32)
        if (c.state.pendingTaskStorySync?.task_id === r.u32) delete c.state.pendingTaskStorySync
        c.push('CSProtoSyncPlayerData', c.state.player)
        sync(c, { del_tasks: [r.u32], del_trace_list: [r.u32] })
        return taskRewards(tables, rewards, 'taskComplete')
    })
    on('TaskClientTrace', (c, r) => {
        const task = activeTask(c.state, r.task_id)
        task.client_trace = !!r.is_trace
        ;(c.state.taskTraceChoices ??= {})[`${r.task_id}:${c.state.taskEpochs?.[r.task_id] ?? 0}`] = !!r.is_trace
        sync(c, r.is_trace ? { trace_id: r.task_id } : { del_trace_list: [r.task_id] })
        return {}
    })
    for (const [name, conditionId] of [
        ['TaskSubmitItem', 2501],
        ['TaskSubmitItemType', 2513],
        ['TaskSubmitItemChoose', 2514],
    ])
        on(name, (c, r) => {
            if (conditionId === 2501 && !(r.items ?? []).length) {
                const graph = graphs.get(r.task_id),
                    index = r.node_index ?? 0
                const config = graph.nodes.get(r.node_id)
                ensure(config, 'Unknown fixed submission node')
                const condition = nodeConditions(config)[index]
                ensure(
                    Number.isInteger(index) && index >= 0 && condition?.conditionId === 2501,
                    'Invalid fixed submission condition',
                )
                const context = { taskId: r.task_id, nodeId: r.node_id, index }
                if (deliveryComplete(c.state, condition, context)) {
                    const task = c.state.tasks.find((task) => task.task_id === r.task_id)
                    ensure(
                        task?.nodes.some((node) => node.node_id === r.node_id) ||
                            task?.finish_nodes.includes(r.node_id) ||
                            (!task &&
                                c.state.taskRecords?.some(
                                    (record) => record.task_id === r.task_id && record.count > 0,
                                )),
                        'Task submission receipt is not active/completed',
                    )
                    sync(c)
                    return {}
                }
            }
            const { node, config } = current(c, r)
            ensure(node.client_before, 'Task node pre-action not acknowledged')
            const conditions = nodeConditions(config),
                index = r.node_index ?? 0
            ensure(
                Number.isInteger(index) && index >= 0 && index < conditions.length,
                'Invalid submission condition index',
            )
            ensure(conditions[index].conditionId === conditionId, 'Wrong task submission protocol')
            const context = { taskId: r.task_id, nodeId: r.node_id, index }
            submitTaskItems(c, conditions[index], context, r.items)
            node.node_values[index] = conditionValue(conditions[index], c.state, context)
            sync(c)
            return {}
        })
    on('TaskClientBefore', (c, r) => {
        if (finished(c, r)) return {}
        const { node, config } = current(c, r)
        applyTaskItemActions(tables, c.state, r.task_id, r.node_id, config, 'before')
        if (node.client_before) {
            sync(c, {}, true)
            return {}
        }
        node.client_before = true
        sync(c, {}, true)
        return {}
    })
    on('TaskRewardNode', (c, r) => {
        const graph = graphs.get(r.task_id),
            task = activeTask(c.state, r.task_id)
        ensure(graph.nodes.has(r.node_id), 'Unknown reward node')
        ensure(
            task.finish_nodes.includes(r.node_id) || (r.node_id === graph.end && task.final_time),
            'Task reward node not finished',
        )
        const rewards = rewardNode(c, task, r.node_id)
        sync(c)
        return taskRewards(tables, rewards)
    })
    on('TaskClientCondAfter', (c, r) => {
        if (finished(c, r)) return {}
        const { graph, node, config } = current(c, r)
        reconcileClearedDungeonBefore(tables, graph, node, c.state)
        ensure(node.client_before, 'Node pre-action is not acknowledged')
        const conditions = nodeConditions(config)
        ensure(
            r.indexes.length > 0 && r.indexes.every((i) => Number.isInteger(i) && i >= 0 && i < conditions.length),
            'Invalid task condition indexes',
        )
        for (const i of new Set(r.indexes)) {
            const value = conditionValue(conditions[i], c.state, {
                taskId: r.task_id,
                nodeId: r.node_id,
                index: i,
            })
            ensure(conditionSatisfied(conditions[i], value), 'Server task condition not complete')
            node.node_values[i] = value
            node.client_cond_after[i] = true
        }
        // The reply callback immediately reads TaskStore.IsEntityComplate.
        // Publish the saved flags first, including retries whose state is unchanged.
        sync(c, {}, true)
        return {}
    })
    on('TaskClientAfter', (c, r) => {
        const previous = finished(c, r)
        if (previous) {
            sync(c)
            return taskRewards(tables, [])
        }
        const { graph, task, node, config } = current(c, r)
        ensure(node.client_before, 'Node pre-action is not acknowledged')
        ensure([10, 20, 30, 50].includes(config.nodeType), 'Task node type is not implemented', 1021)
        const conditions = nodeConditions(config)
        node.node_values = conditions.map((q, index) =>
            conditionValue(q, c.state, { taskId: r.task_id, nodeId: r.node_id, index }),
        )
        // TaskEntityCreatePlayerData.StepOver(1) reports After as soon as the
        // creation page opens. The actual PlayerCustomData request arrives later.
        if (conditions.length === 1 && conditions[0].conditionId === 2505 && !node.node_values[0]) {
            c.state.pendingCharacterTask = {
                task_id: r.task_id,
                node_id: r.node_id,
                epoch: c.state.taskEpochs?.[r.task_id] ?? 0,
            }
            sync(c)
            return taskRewards(tables, [])
        }
        ensure(
            node.node_values.every((n, i) => conditionSatisfied(conditions[i], n)),
            'Server task conditions not complete',
        )
        if (c.state.pendingCharacterTask?.task_id === r.task_id && c.state.pendingCharacterTask.node_id === r.node_id)
            delete c.state.pendingCharacterTask
        const rewards = rewardNode(c, task, r.node_id)
        applyTaskItemActions(tables, c.state, r.task_id, r.node_id, config, 'after')
        c.state.taskAfterReceipts ??= {}
        c.state.taskAfterReceipts[deliveryKey(c.state, r.task_id, r.node_id, 'after')] = rewards
        if (config.nodeType === 50) {
            const first = !task.final_time
            task.final_time ??= c.now
            sync(c)
            if (first) c.push('CSProtoNotifyTaskEndNode', { task_id: r.task_id })
            return taskRewards(tables, rewards)
        }
        const next = asList(config.nextNodeIdList)
        ensure(next.length > 0, 'Task node has no successor', 1007)
        ensure(new Set(next).size === next.length, 'Duplicate task edges', 1007)
        ensure(
            next.every((id) => !task.finish_nodes.includes(id)),
            'Cyclic task graph requires loop state',
            1007,
        )
        task.nodes = task.nodes.filter((n) => n.node_id !== r.node_id)
        if (!task.finish_nodes.includes(r.node_id)) task.finish_nodes.push(r.node_id)
        for (const id of next)
            if (!task.nodes.some((n) => n.node_id === id)) task.nodes.push(makeNode(graph, id, c.state))
        advancePetChoiceBranch(graph, task, c.state)
        deferTaskSyncUntilAfterStories(c.state, r.task_id, r.node_id, config)
        sync(c)
        return taskRewards(tables, rewards)
    })
    for (const suffix of ['Before', 'After', 'CondAfter'])
        on('MultiTaskClient' + suffix, (c, r) => {
            ensure(
                Array.isArray(r.task_params) && r.task_params.length > 0 && r.task_params.length <= 128,
                'Invalid task callback batch',
            )
            const seen = new Set(),
                rewards = []
            for (const param of r.task_params) {
                const key = `${param.task_id}:${param.node_id}`
                ensure(!seen.has(key), 'Duplicate task callback')
                seen.add(key)
                const result = handlers.get('TaskClient' + suffix)(c, param)
                rewards.push(...(result?.rewards ?? []))
            }
            return suffix === 'After' ? taskRewards(tables, rewards) : {}
        })
    const finishPendingCharacterTask = (c) => {
        const pending = c.state.pendingCharacterTask
        if (!pending || !c.state.characterCustomized) return
        if ((c.state.taskEpochs?.[pending.task_id] ?? 0) !== pending.epoch) {
            delete c.state.pendingCharacterTask
            return
        }
        const task = c.state.tasks.find((t) => t.task_id === pending.task_id)
        if (!task?.nodes.some((n) => n.node_id === pending.node_id)) {
            delete c.state.pendingCharacterTask
            return
        }
        handlers.get('TaskClientAfter')(c, pending)
    }
    const recoverCompletedCampaignTasks = (c) => {
        if (c.state.storyCampaign || c.state.entrust?.run || c.state.multiCampaign) return []
        const recovered = []
        for (const task of [...c.state.tasks]) {
            if (c.state.pendingTaskStorySync?.task_id === task.task_id) continue
            const graph = graphs.get(task.task_id)
            for (const node of [...task.nodes]) {
                if (!canRecoverClearedDungeonNode(tables, graph, node, c.state)) continue
                const conditions = nodeConditions(graph.nodes.get(node.node_id))
                if (
                    !conditions.every((condition, index) =>
                        conditionSatisfied(
                            condition,
                            conditionValue(condition, c.state, { taskId: task.task_id, nodeId: node.node_id, index }),
                        ),
                    )
                )
                    continue
                const next = asList(graph.nodes.get(node.node_id).nextNodeIdList)
                if (!next.length || next.some((id) => task.finish_nodes.includes(id))) continue
                reconcileClearedDungeonBefore(tables, graph, node, c.state)
                const request = { task_id: task.task_id, node_id: node.node_id }
                const indexes = conditions.flatMap((condition, index) =>
                    condition.conditionId === 12017 ? [index] : [],
                )
                handlers.get('TaskClientCondAfter')(c, { ...request, indexes })
                handlers.get('TaskClientAfter')(c, request)
                recovered.push(request)
            }
        }
        return recovered
    }
    return { finishPendingCharacterTask, recoverCompletedCampaignTasks }
}
