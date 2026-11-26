import { ErrorCode } from './error-codes.js'
import {
    TaskGraphs,
    activeTask,
    nodeConditions,
    conditionValue,
    reconcileTaskBefore,
    taskVisibleAtLevel,
} from './tasks.js'
import { deliveryKey } from './task-delivery.js'
import { ensure } from './handlers/common.js'
import { validateTaskRangeEvent, validateTaskPlayableStepEvent } from './task-condition-events.js'

// CBT3 TaskStore 060189b0/b1: targeted reports, not generic telemetry.
const indexed = new Set([1001, 2519, 2520, 2512])
const catalogs = new WeakMap()
function ownsFractalPet(c, data) {
    const petTables = Object.fromEntries(
        ['pet_rank', 'world_enemy_group', 'enemy'].map((name) => [name, c.tables.get(name)]),
    )
    const groupId = data.enemyData?.__type_TaskEnemiesOverrideData?.enemiesGroupId
    const group = petTables.world_enemy_group.find((r) => r.id === groupId),
        ids = String(group?.enemyList ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number)
    ensure(ids.length === 1, 'Task catch pet group unavailable', ErrorCode.GameConfig)
    const petId = petTables.enemy.find((r) => r.id === ids[0])?.petId,
        customized = c.tables.find('pet_customized', petId),
        // Current TaskPetConditionHelper0602f203 probes pet_customized by
        // key before resolving pet_rank; owned profiles use the base species.
        basePetId = customized ? customized.petId : petId,
        petGroup = petTables.pet_rank.find((r) => r.petId === basePetId)?.petGroup
    ensure(Number.isInteger(petGroup) && petGroup > 0, 'Task catch pet configuration unavailable', ErrorCode.GameConfig)
    return c.state.pets.some((p) => petTables.pet_rank.some((r) => r.petId === p.config_id && r.petGroup === petGroup))
}
function recordScopedEvent(c, r, graphs) {
    const a = r.args ?? [],
        fractal = r.key === 2526
    ensure(
        a.length === (fractal ? 4 : 2) && a.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff),
        'Invalid task event arguments',
    )
    const task = activeTask(c.state, a[0]),
        graph = graphs.get(task.task_id),
        matches = []
    ensure(fractal ? [1, 2].includes(a[3]) : a[1] === 1, 'Invalid task event stage')
    for (const node of task.nodes) {
        if (!node.client_before) continue
        nodeConditions(graph.nodes.get(node.node_id)).forEach((q, index) => {
            if (q.conditionId !== r.key) return
            const data = q.__type_TaskConditionBaseData
            if (fractal) {
                const d = data?.__type_TaskCondFractalPetCatchData
                if (!d || d.uniKey !== a[2] || (d.enemyData?.createNpcId ?? 0) !== a[1]) return
            }
            matches.push({ node, q, index })
        })
    }
    ensure(matches.length === 1, 'Task event has no unique active condition')
    const { node, q, index } = matches[0],
        base = q.__type_TaskConditionBaseData,
        d = base.__type_TaskCondFractalPetCatchData
    const map = base.mapData?.sceneId || d?.enemyData?.sceneId
    ensure(!map || map === c.state.world.map_id, 'Task event is in a different map')
    if (fractal && a[3] === 2) ensure(ownsFractalPet(c, d), 'Required task pet is not owned')
    const key = deliveryKey(c.state, task.task_id, node.node_id, index),
        events = (c.state.taskEvents ??= {})
    events[key] = Math.max(events[key] ?? 0, fractal ? a[3] : 1)
    node.node_values[index] = conditionValue(q, c.state, { taskId: task.task_id, nodeId: node.node_id, index })
    if (taskVisibleAtLevel(c.tables, c.state, task)) c.push('CSProtoTaskSync', { tasks: [task] })
    return true
}
function timeReportMatches(data, hour) {
    if (!data || ![0, 1, 2, 3].includes(data.checkNameType)) return false
    if (data.checkNameType === 3) return hour === 0 && data.delayTime >= 0
    const start = data.checkNameType === 1 ? 0 : data.startTime
    const end = data.checkNameType === 0 ? 48 : data.endTime
    return (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end <= 48 &&
        end > start &&
        hour >= start &&
        hour < end
    )
}

function recordTimeEvent(c, r, graphs) {
    const [hour, count, ...extra] = r.args ?? []
    ensure(
        !extra.length && Number.isInteger(hour) && hour >= 0 && hour < 24 && count === 1,
        'Invalid task time event arguments',
    )
    const matches = []
    let hasTimeNode = false
    for (const task of c.state.tasks ?? [])
        for (const node of task.nodes) {
            nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id)).forEach((q, index) => {
                const data = q.__type_TaskConditionBaseData?.__type_TaskCondTimeTriggerData
                if (q.conditionId !== 1100) return
                hasTimeNode = true
                if (timeReportMatches(data, hour)) matches.push({ task, node, q, index })
            })
        }
    if (!matches.length && Object.values(c.state.taskTimeReports ?? {}).some((report) => report.hour === hour))
        return true
    if (!hasTimeNode) return false
    ensure(matches.length === 1, 'Task time event has no unique active condition')
    const { task, node, q, index } = matches[0]
    const key = deliveryKey(c.state, task.task_id, node.node_id, index)
    if (c.state.taskEvents?.[key]) return true
    // The client checks elapsed task days/jumpDay before emitting this report.
    // ReqDoTaskStep carries only [passHour,1], not taskId/day; route it only
    // when one active configured time condition matches. WorldTimeSync alone
    // cannot attest that tomorrow was selected or the local delay elapsed.
    ;(c.state.taskEvents ??= {})[key] = 1
    ;(c.state.taskTimeReports ??= {})[key] = { hour, time: c.now }
    node.node_values[index] = conditionValue(q, c.state, { taskId: task.task_id, nodeId: node.node_id, index })
    if (taskVisibleAtLevel(c.tables, c.state, task)) c.push('CSProtoTaskSync', { tasks: [task] })
    return true
}

export function recoverCachedTaskTimeEvent(c) {
    const graphs = new TaskGraphs(c.tables)
    const active = (c.state.tasks ?? []).filter((task) =>
        task.nodes.some((node) =>
            nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id)).some((q) => q.conditionId === 1100),
        ),
    )
    if (active.length !== 1) return false
    const task = active[0],
        graph = graphs.get(task.task_id)
    // A generic cache has no task ID. Recover only the first time condition
    // of this task epoch, with no already-finished timer to confuse it with.
    if ((task.finish_nodes ?? []).some((id) => nodeConditions(graph.nodes.get(id)).some((q) => q.conditionId === 1100)))
        return false
    const event = [...(c.state.clientBehaviour ?? [])]
        .reverse()
        .find((record) => record.key === 1100 && record.time >= (task.start_time ?? Infinity) && record.time <= c.now)
    if (!event) return false
    // An already completed timer quest after this cached report makes its
    // original owner uncertain. Do not credit the active task in that case.
    try {
        if (
            (c.state.taskRecords ?? []).some(
                (record) =>
                    record.time >= event.time &&
                    [...graphs.get(record.task_id).nodes.values()].some((node) =>
                        nodeConditions(node).some((q) => q.conditionId === 1100),
                    ),
            )
        )
            return false
    } catch {
        return false
    }
    try {
        return recordTimeEvent({ ...c, push: () => {} }, event, graphs)
    } catch {
        return false
    }
}
export function virtualStateReportTarget(data) {
    return data?.createNpcId > 0 ? data.createNpcId : data?.worldMapId
}
function isLateOptionalNpc(condition, target) {
    const base = condition?.__type_TaskConditionBaseData
    if (![true, 1].includes(base?.unneedCompleted)) return false
    const npc = base.__type_TaskCondNPCTriggerData
    const active = base.__type_TaskCondActiveNPCTriggerData ?? base.__type_TaskCondActiveSpecialNPCTriggerData
    const expected = npc?.npcId ?? (active?.isNowCreate ? active.npcData?.createNpcId : active?.createNpcId)
    return Number.isSafeInteger(expected) && expected > 0 && expected === target
}
export function recordTaskBehaviour(c, r) {
    if (!indexed.has(r.key) && ![1100, 2508, 2526].includes(r.key)) return false
    let graphs = catalogs.get(c.tables)
    if (!graphs) {
        graphs = new TaskGraphs(c.tables)
        catalogs.set(c.tables, graphs)
    }
    if (r.key === 1100) return recordTimeEvent(c, r, graphs)
    if (!indexed.has(r.key)) return recordScopedEvent(c, r, graphs)
    const a = r.args ?? [],
        photo = r.key === 2512
    ensure(a.length === (photo ? 4 : 5) && a.every(Number.isInteger), 'Invalid task event arguments')
    const [target, taskId, nodeId, index, count] = photo ? [0, ...a] : a
    ensure(count === 1, 'Invalid task event count')
    const graph = graphs.get(taskId)
    const previousTask = c.state.tasks?.find((task) => task.task_id === taskId)
    if (!previousTask && c.state.taskRecords?.some((record) => record.task_id === taskId && record.count > 0)) {
        const completed = nodeConditions(graph.nodes.get(nodeId))[index]
        if (completed?.conditionId === r.key && isLateOptionalNpc(completed, target)) return true
    }
    const task = activeTask(c.state, taskId),
        node = task.nodes.find((n) => n.node_id === nodeId)
    if (!node && task.finish_nodes.includes(nodeId)) {
        const completed = nodeConditions(graph.nodes.get(nodeId))[index]
        ensure(
            completed?.conditionId === r.key &&
                ((c.state.taskEvents?.[deliveryKey(c.state, taskId, nodeId, index)] ?? 0) > 0 ||
                    !!completed.__type_TaskConditionBaseData?.__type_TaskCondInSceneData ||
                    isLateOptionalNpc(completed, target) ||
                    (completed.__type_TaskConditionBaseData?.__type_TaskCondPlayableIsFinishData &&
                        conditionValue(completed, c.state, { taskId, nodeId, index }) > 0)),
            'Task event was not previously completed',
        )
        return true
    }
    ensure(node, 'Task node is not active')
    // The node is already active in server state; client_before acknowledges
    // its preceding actions and may arrive after a queued interaction event.
    // Recording this event does not acknowledge those actions or advance a node.
    const condition = nodeConditions(graph.nodes.get(nodeId))[index]
    ensure(condition && condition.conditionId === r.key, 'Task event condition mismatch')
    const base = condition.__type_TaskConditionBaseData ?? {}
    const scene = base.__type_TaskCondInSceneData
    const playable = base.__type_TaskCondPlayableIsFinishData
    const areaTrigger = base.__type_TaskCondAreaTriggerData
    const rangeTrigger = base.__type_TaskCondRangeTriggerData
    const playableStep = base.__type_TaskCondPlayableStepData
    const virtualState = base.__type_TaskCondWorldUnitVirtualStateData
    const data =
        scene ??
        playable ??
        virtualState ??
        areaTrigger ??
        rangeTrigger ??
        playableStep ??
        base.__type_TaskCondNPCTriggerData ??
        base.__type_TaskCondActiveNPCTriggerData ??
        base.__type_TaskCondActiveSpecialNPCTriggerData ??
        base.__type_TaskCondEnemiesGroupData ??
        base.__type_TaskCondPhotoSceneData ??
        base.__type_TaskCondPackageDownloadCompleteData ??
        base.__type_TaskCondSignalReceiverData
    ensure(
        data,
        `Task event configuration unavailable (${taskId}/${nodeId}/${index}, content ${condition.contentType})`,
        ErrorCode.GameConfig,
    )
    if (virtualState)
        ensure(
            condition.contentType === 16660 &&
                r.key === 2519 &&
                Number.isSafeInteger(virtualState.worldMapId) &&
                virtualState.worldMapId > 0 &&
                typeof virtualState.virtualState === 'string' &&
                virtualState.virtualState.length > 0,
            'Invalid world virtual-state condition',
            ErrorCode.GameConfig,
        )
    const area = areaTrigger ? c.tables.find('world_area_unit_define', areaTrigger.configId) : null
    if (areaTrigger)
        ensure(
            condition.contentType === 16350 &&
                r.key === 2519 &&
                area &&
                Number.isInteger(area.sceneId) &&
                area.sceneId > 0,
            'Task area trigger configuration unavailable',
            ErrorCode.GameConfig,
        )
    // The exported NPC-trigger payload calls its storyId `sceneId`; the CBT3
    // TaskCondNPCTriggerData/TaskCondActiveNPCTriggerData classes confirm that
    // field identifies a story, not a world map. Use only actual map fields.
    const npc = base.__type_TaskCondNPCTriggerData,
        activeNpc = base.__type_TaskCondActiveNPCTriggerData ?? base.__type_TaskCondActiveSpecialNPCTriggerData
    const map =
        area?.sceneId ??
        scene?.sceneId ??
        (playable?.sceneID ||
            playableStep?.sceneID ||
            base.mapData?.sceneId ||
            activeNpc?.npcData?.sceneId ||
            (!npc && !activeNpc ? data.sceneId || data.enemiesDatas?.sceneId : 0))
    ensure(!map || map === c.state.world.map_id, 'Task event is in a different map')
    if (!photo) {
        const expected =
            scene?.sceneId ??
            (playable || playableStep
                ? (playable ?? playableStep).playableID
                : virtualState
                  ? virtualStateReportTarget(virtualState)
                  : base.__type_TaskCondSignalReceiverData
                    ? data.signalType
                    : base.__type_TaskCondPackageDownloadCompleteData
                      ? 0xffffffff
                      : r.key === 1001
                        ? data.npcId
                        : r.key === 2519 && data.isNowCreate
                          ? data.npcData?.createNpcId
                          : data.createNpcId)
        ensure(Number.isSafeInteger(expected) && expected === target, 'Task event target mismatch')
    }
    if (playable)
        ensure(
            conditionValue(condition, c.state, { taskId, nodeId, index }) > 0,
            'Playable has no matching server completion record',
        )
    if (rangeTrigger || playableStep) {
        ensure(
            r.key === 2519 && condition.contentType === (rangeTrigger ? 16370 : 16650),
            'Invalid typed task event configuration',
            ErrorCode.GameConfig,
        )
        if (rangeTrigger) {
            ensure(
                Number.isSafeInteger(base.mapData?.sceneId) && base.mapData.sceneId > 0,
                'Task range scene configuration unavailable',
                ErrorCode.GameConfig,
            )
            validateTaskRangeEvent(
                c,
                task,
                rangeTrigger,
                c.state.taskEvents?.[deliveryKey(c.state, taskId, nodeId, index)] ?? 0,
                { graph, node },
            )
        } else
            validateTaskPlayableStepEvent(
                c,
                playableStep,
                c.state.taskEvents?.[deliveryKey(c.state, taskId, nodeId, index)] ?? 0,
            )
    }
    // These reports attest client-owned interactions. They cannot grant items or
    // bypass exact-item submission, account-level or other server-owned conditions.
    const key = deliveryKey(c.state, taskId, nodeId, index),
        events = (c.state.taskEvents ??= {})
    const required = Math.max(1, Number(data.count) || 1)
    ensure(
        Number.isSafeInteger(required) && required <= 0xffffffff,
        'Invalid task event requirement',
        ErrorCode.GameConfig,
    )
    events[key] = Math.min(required, (events[key] ?? 0) + 1)
    node.node_values[index] = conditionValue(condition, c.state, { taskId, nodeId, index })
    reconcileTaskBefore(c.tables, graph, task, node, c.state)
    if (taskVisibleAtLevel(c.tables, c.state, task)) c.push('CSProtoTaskSync', { tasks: [task] })
    return true
}
