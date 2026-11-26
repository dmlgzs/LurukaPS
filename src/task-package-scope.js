import policy from '../configs/task-package-scope-policy.json' with { type: 'json' }
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const modeValue = (value) => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff
export function validateTaskPackagePolicy(value) {
    ensure(
        object(value) &&
            value.schemaVersion === 1 &&
            value.policyId === 'task-package-scope-1.0.0-v1' &&
            value.origin === 'LOCAL' &&
            value.targetVersion === '1.0.0' &&
            value.packageVersion === '3217420' &&
            value.selection === 'server-deployment-only' &&
            typeof value.isReviewPackage === 'boolean',
        'Task package deployment policy is malformed',
        ErrorCode.GameConfig,
    )
    return value
}
validateTaskPackagePolicy(policy)

// Current Native: mode0 rejects review packages, mode2 rejects non-review;
// every other int32 value is accepted. This is a build/package scope, not replay.
export function taskPackageEligible(config, deployment = policy) {
    if (deployment !== policy) validateTaskPackagePolicy(deployment)
    const mode = config?.isReviewMode_tishen
    ensure(modeValue(mode), 'Task package mode is missing or malformed', ErrorCode.GameConfig)
    return mode === 0 ? !deployment.isReviewPackage : mode === 2 ? deployment.isReviewPackage : true
}
function ledger(state) {
    const value = state.taskPackageIsolation
    if (value === undefined) return undefined
    ensure(
        object(value) &&
            value.version === 1 &&
            value.policyId === policy.policyId &&
            value.targetVersion === policy.targetVersion &&
            Array.isArray(value.records) &&
            positive(value.nextRecord),
        'Task package isolation ledger is malformed',
        ErrorCode.GameConfig,
    )
    const ids = new Set()
    for (const row of value.records) {
        ensure(
            object(row) &&
                positive(row.recordId) &&
                !ids.has(row.recordId) &&
                row.recordId < value.nextRecord &&
                positive(row.taskId) &&
                modeValue(row.packageMode) &&
                uint(row.epoch) &&
                typeof row.epochPresent === 'boolean' &&
                uint(row.isolatedAt) &&
                typeof row.serverReviewPackage === 'boolean' &&
                ['isolated', 'restored'].includes(row.status) &&
                object(row.rawTask) &&
                row.rawTask.task_id === row.taskId &&
                object(row.pending),
            'Archived task package instance is malformed',
            ErrorCode.GameConfig,
        )
        ids.add(row.recordId)
    }
    ensure(Array.isArray(value.references ?? []), 'Task package reference archive is malformed', ErrorCode.GameConfig)
    for (const row of value.references ?? []) {
        ensure(
            object(row) &&
                positive(row.recordId) &&
                !ids.has(row.recordId) &&
                row.recordId < value.nextRecord &&
                row.field === 'pendingTaskStorySync.extra.new_task_ids' &&
                positive(row.ownerTaskId) &&
                Array.isArray(row.rawTaskIds) &&
                row.rawTaskIds.every(positive) &&
                Array.isArray(row.removedTaskIds) &&
                row.removedTaskIds.length > 0 &&
                row.removedTaskIds.every((id) => positive(id) && row.rawTaskIds.includes(id)) &&
                uint(row.isolatedAt),
            'Archived task package reference is malformed',
            ErrorCode.GameConfig,
        )
        ids.add(row.recordId)
    }
    return value
}
export function packageIsolatedTaskIds(state) {
    return [
        ...new Set((ledger(state)?.records ?? []).filter((row) => row.status === 'isolated').map((row) => row.taskId)),
    ]
}
export function taskPackageRestoreRequired(state, taskId) {
    return (ledger(state)?.records ?? []).some((row) => row.taskId === taskId && row.status === 'isolated')
}

// Writable transaction only, after typed GUID migration but before automatic
// acceptance, scene/trial reconstruction or combat-source discovery. No old
// task records/reward receipts, appearance or combat/HP are edited here.
export function reconcileTaskPackageScope(tables, state, now, deployment = policy) {
    validateTaskPackagePolicy(deployment)
    ensure(
        Array.isArray(state.tasks) && uint(now),
        'Task package reconciliation input is malformed',
        ErrorCode.GameConfig,
    )
    const existing = ledger(state),
        seen = new Set(),
        incompatible = []
    for (const task of state.tasks) {
        ensure(
            object(task) && positive(task.task_id) && !seen.has(task.task_id),
            'Active task identity is malformed',
            ErrorCode.GameConfig,
        )
        seen.add(task.task_id)
        const config = tables.find('task', task.task_id)
        // Unknown/retired graph compatibility has its own archive and error policy.
        if (!config) continue
        if (!taskPackageEligible(config, deployment)) incompatible.push({ task, config })
    }
    const incompatibleIds = new Set(incompatible.map((row) => row.task.task_id)),
        barrier = state.pendingTaskStorySync,
        extraIds = barrier?.extra?.new_task_ids
    let reference
    if (extraIds !== undefined && !incompatibleIds.has(barrier.task_id)) {
        ensure(
            Array.isArray(extraIds) && extraIds.every(positive),
            'Pending task notification IDs are malformed',
            ErrorCode.GameConfig,
        )
        const removed = extraIds.filter((id) => {
            const config = tables.find('task', id)
            return config && !taskPackageEligible(config, deployment)
        })
        if (removed.length) {
            ensure(positive(barrier.task_id), 'Pending story task owner is malformed', ErrorCode.GameConfig)
            reference = {
                ownerTaskId: barrier.task_id,
                rawTaskIds: structuredClone(extraIds),
                removedTaskIds: removed,
                kept: extraIds.filter((id) => !removed.includes(id)),
            }
        }
    }
    if (!incompatible.length && !reference) return { changed: false, isolatedIds: [] }
    const next = existing
            ? structuredClone(existing)
            : {
                  version: 1,
                  policyId: policy.policyId,
                  targetVersion: policy.targetVersion,
                  nextRecord: 1,
                  records: [],
                  references: [],
              },
        remove = new Set(),
        pendingKeys = ['pendingTaskStorySync', 'pendingTaskScene', 'pendingCharacterTask']
    for (const { task, config } of incompatible) {
        const taskId = task.task_id,
            epochPresent = state.taskEpochs?.[taskId] !== undefined,
            epoch = state.taskEpochs?.[taskId] ?? 0
        ensure(
            uint(epoch) && !next.records.some((row) => row.taskId === taskId && row.status === 'isolated'),
            'Active task conflicts with an already isolated package instance',
            ErrorCode.GameConfig,
        )
        ensure(next.nextRecord < 0xffffffff, 'Task package archive identity exhausted', ErrorCode.InvalidLogic)
        const pending = {}
        for (const key of pendingKeys) if (state[key]?.task_id === taskId) pending[key] = structuredClone(state[key])
        next.records.push({
            recordId: next.nextRecord++,
            taskId,
            packageMode: config.isReviewMode_tishen,
            epoch,
            epochPresent,
            isolatedAt: now,
            serverReviewPackage: deployment.isReviewPackage,
            status: 'isolated',
            rawTask: structuredClone(task),
            pending,
        })
        remove.add(taskId)
    }
    if (reference) {
        ensure(next.nextRecord < 0xffffffff, 'Task package archive identity exhausted', ErrorCode.InvalidLogic)
        ;(next.references ??= []).push({
            recordId: next.nextRecord++,
            field: 'pendingTaskStorySync.extra.new_task_ids',
            ownerTaskId: reference.ownerTaskId,
            rawTaskIds: reference.rawTaskIds,
            removedTaskIds: reference.removedTaskIds,
            isolatedAt: now,
        })
    }
    state.taskPackageIsolation = next
    state.tasks = state.tasks.filter((task) => !remove.has(task.task_id))
    for (const key of pendingKeys) if (remove.has(state[key]?.task_id)) delete state[key]
    if (reference)
        state.pendingTaskStorySync = { ...barrier, extra: { ...barrier.extra, new_task_ids: reference.kept } }
    // Keep taskEpochs and all claim/record histories. A later manual deployment
    // restore must validate the original graph and restore this same epoch;
    // taskUnlocked blocks auto-reaccept while the archive remains isolated.
    return { changed: true, isolatedIds: [...remove] }
}
