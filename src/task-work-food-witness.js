import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { deliveryKey } from './task-delivery.js'
import { guidedConditionValue, guidedWorkFoodRule } from './guided-conditions.js'
import { workFraction, workCompare, workSerialize } from './production-work-fractions.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])
const canonical = (value) =>
    JSON.stringify(value, function (_, entry) {
        return object(entry)
            ? Object.fromEntries(
                  Object.keys(entry)
                      .sort()
                      .map((key) => [key, entry[key]]),
              )
            : entry
    })
const fingerprint = (condition, rule) =>
    createHash('sha256')
        .update(canonical({ condition, guided: rule.definition, target: rule.target }))
        .digest('hex')
function ruleOf(condition) {
    if (condition?.conditionId !== 2518) return null
    const id = condition.__type_TaskConditionBaseData?.__type_TaskCondGuidedAchievementsData?.achievId
    const rule = guidedWorkFoodRule(id)
    return rule && { ...rule, id, fingerprint: fingerprint(condition, rule) }
}
function activeNode(state, context) {
    const task = state.tasks?.find((entry) => entry.task_id === context.taskId)
    if (!task || task.finish_nodes?.includes(context.nodeId)) return null
    const node = task.nodes?.find((entry) => entry.node_id === context.nodeId)
    return node?.client_before === true ? node : null
}
function snapshot(state) {
    return {
        builds: (state.home?.builds ?? [])
            .filter((build) => build.build_type === 6 && build.locate)
            .map((build) => ({
                guid: build.guid,
                build_type: 6,
                locate: true,
                pet_canteen: { foods: (build.pet_canteen?.foods ?? []).map((food) => ({ ...food })) },
            })),
    }
}
function validateSnapshot(value) {
    ensure(object(value) && Array.isArray(value.builds), 'Invalid work-food stock snapshot', ErrorCode.GameConfig)
    const seen = new Set()
    const quantities = new Map()
    for (const build of value.builds) {
        ensure(
            object(build) &&
                positive(build.guid) &&
                !seen.has(build.guid) &&
                build.build_type === 6 &&
                build.locate === true &&
                Array.isArray(build.pet_canteen?.foods),
            'Invalid work-food snapshot building',
            ErrorCode.GameConfig,
        )
        seen.add(build.guid)
        const items = new Set()
        for (const food of build.pet_canteen.foods) {
            ensure(
                object(food) &&
                    positive(food.itemid) &&
                    positive(food.itemnum) &&
                    !items.has(food.itemid) &&
                    (food.itemtype === undefined || food.itemtype === 3),
                'Invalid work-food snapshot quantity',
                ErrorCode.GameConfig,
            )
            items.add(food.itemid)
            quantities.set(`${build.guid}:${food.itemid}`, food.itemnum)
        }
    }
    return quantities
}
function stockValue(rule, stock) {
    return guidedConditionValue(rule.id, { home: stock })
}
function recovery(state) {
    return workFraction(state.home?.productionWork?.stats?.recovery ?? 0)
}
function viewLedger(state) {
    const ledger = state.taskWorkFoodWitnesses
    ensure(ledger === undefined || object(ledger), 'Invalid work-food task witness ledger', ErrorCode.GameConfig)
    return ledger
}
function validateWitness(state, record, context, rule) {
    ensure(
        object(record) &&
            record.version === 1 &&
            record.taskId === context.taskId &&
            record.epoch === (state.taskEpochs?.[context.taskId] ?? 0) &&
            record.nodeId === context.nodeId &&
            record.index === context.index &&
            positive(record.value) &&
            positive(record.target) &&
            typeof record.fingerprint === 'string' &&
            /^[a-f0-9]{64}$/.test(record.fingerprint),
        'Invalid work-food task witness',
        ErrorCode.GameConfig,
    )
    if (record.fingerprint !== rule.fingerprint) return false
    ensure(
        record.target === rule.target &&
            record.value >= rule.target &&
            object(record.source) &&
            record.source.kind === 'production-work-feeding' &&
            uint(record.source.at) &&
            typeof record.source.policyVersion === 'string' &&
            record.source.policyVersion.length > 0 &&
            object(record.source.recoveryBefore) &&
            object(record.source.recoveryAfter),
        'Invalid work-food witness source',
        ErrorCode.GameConfig,
    )
    const before = validateSnapshot(record.stockBefore),
        after = validateSnapshot(record.stockAfter)
    let removed = false
    for (const [key, count] of after)
        ensure(before.has(key) && before.get(key) >= count, 'Work-food witness stock increased', ErrorCode.GameConfig)
    for (const [key, count] of before) if ((after.get(key) ?? 0) < count) removed = true
    ensure(
        removed &&
            stockValue(rule, record.stockBefore) === record.value &&
            stockValue(rule, record.stockAfter) < rule.target,
        'Work-food witness never crossed its condition',
        ErrorCode.GameConfig,
    )
    const first = workFraction(record.source.recoveryBefore),
        last = workFraction(record.source.recoveryAfter)
    ensure(
        workCompare(first, 0) >= 0 && workCompare(last, first) > 0 && workCompare(recovery(state), last) >= 0,
        'Work-food witness has no actual model recovery',
        ErrorCode.GameConfig,
    )
    return true
}

// Pure and narrow: no task scan when no managed production/usable stock exists.
export function captureWorkFoodTaskSnapshot(state, policy, getGraphs) {
    if (!state.tasks?.length || !state.home || !Array.isArray(policy?.scope)) return null
    const jobs = Object.values(state.home.productionJobs ?? {})
    if (
        !jobs.some(
            (queue) =>
                Array.isArray(queue) &&
                queue.some(
                    (job) =>
                        (job.workEpoch !== undefined || policy.scope.includes(job.kind ?? 'ordinary')) &&
                        (job.workCompleted ?? 0) < job.count,
                ),
        )
    )
        return null
    if (
        !state.home.builds?.some(
            (build) =>
                build.build_type === 6 &&
                build.locate &&
                Array.isArray(build.pet_canteen?.foods) &&
                build.pet_canteen.foods.some((food) => food.itemnum > 0),
        )
    )
        return null
    const graphs = getGraphs(),
        stockBefore = snapshot(state),
        candidates = []
    for (const task of state.tasks) {
        const ready =
            task.nodes?.filter((node) => node.client_before === true && !task.finish_nodes?.includes(node.node_id)) ??
            []
        if (!ready.length) continue
        const graph = graphs.get(task.task_id)
        for (const node of ready) {
            const raw = graph.nodes.get(node.node_id)
            const conditions = list(
                (raw?.__type_TaskConditionNodeData ?? raw?.__type_TaskConditonBranchNodeData)?.conditionList,
            )
            conditions.forEach((condition, index) => {
                const rule = ruleOf(condition)
                if (!rule) return
                const value = guidedConditionValue(rule.id, state)
                if (value < rule.target) return
                candidates.push({
                    context: { taskId: task.task_id, nodeId: node.node_id, index },
                    epoch: state.taskEpochs?.[task.task_id] ?? 0,
                    condition: structuredClone(condition),
                    rule,
                    value,
                })
            })
        }
    }
    return candidates.length ? { candidates, stockBefore, recoveryBefore: workSerialize(recovery(state)) } : null
}

export function recordWorkFoodTaskWitnesses(state, captured, now) {
    if (!captured || workCompare(recovery(state), captured.recoveryBefore) <= 0) return false
    ensure(uint(now), 'Invalid work-food witness time', ErrorCode.GameConfig)
    const stockAfter = snapshot(state)
    let changed = false
    for (const candidate of captured.candidates) {
        const { context, condition, rule, value, epoch } = candidate
        if (
            !activeNode(state, context) ||
            (state.taskEpochs?.[context.taskId] ?? 0) !== epoch ||
            guidedConditionValue(rule.id, state) >= rule.target
        )
            continue
        const key = deliveryKey(state, context.taskId, context.nodeId, context.index),
            existing = viewLedger(state)?.[key]
        if (existing && validateWitness(state, existing, context, rule)) continue
        const record = {
            version: 1,
            taskId: context.taskId,
            epoch,
            nodeId: context.nodeId,
            index: context.index,
            fingerprint: fingerprint(condition, rule),
            value,
            target: rule.target,
            stockBefore: structuredClone(captured.stockBefore),
            stockAfter: structuredClone(stockAfter),
            source: {
                kind: 'production-work-feeding',
                at: now,
                policyVersion: state.home.productionWork.policyVersion,
                recoveryBefore: captured.recoveryBefore,
                recoveryAfter: workSerialize(recovery(state)),
            },
        }
        ensure(validateWitness(state, record, context, rule), 'New work-food witness is invalid', ErrorCode.GameConfig)
        ;(state.taskWorkFoodWitnesses ??= {})[key] = record
        changed = true
    }
    if (changed) {
        const revision = state.taskWorkFoodWitnessRevision ?? 0
        ensure(
            Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER,
            'Invalid work-food witness revision',
            ErrorCode.GameConfig,
        )
        state.taskWorkFoodWitnessRevision = revision + 1
    }
    return changed
}

export function workFoodTaskConditionValue(condition, state, context, current) {
    if (!context || !activeNode(state, context)) return current
    const rule = ruleOf(condition)
    if (!rule) return current
    const record = viewLedger(state)?.[deliveryKey(state, context.taskId, context.nodeId, context.index)]
    if (!record || !validateWitness(state, record, context, rule)) return current
    if (context.phase === 'after' && activeNode(state, context).client_cond_after?.[context.index] !== true)
        return current
    return Math.max(current, record.value)
}

export function clearWorkFoodTaskWitnesses(state, taskId, nodeId) {
    const ledger = viewLedger(state)
    if (!ledger) return false
    const prefix = nodeId === undefined ? `${taskId}:` : `${taskId}:${state.taskEpochs?.[taskId] ?? 0}:${nodeId}:`
    let changed = false
    for (const key of Object.keys(ledger))
        if (key.startsWith(prefix)) {
            delete ledger[key]
            changed = true
        }
    if (changed && !Object.keys(ledger).length) delete state.taskWorkFoodWitnesses
    return changed
}
