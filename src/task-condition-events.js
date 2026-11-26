import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import configuredPolicy from '../configs/task-condition-event-policy.json' with { type: 'json' }
import { taskOverrideNodeIds } from './task-action-data.js'
import { tableExportManifest } from './table-source.js'

const f = Math.fround
const vector = (value) => value && ['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]))

export function validateTaskConditionEventPolicy(policy) {
    ensure(
        policy?.schema_version === 1 &&
            policy.origin === 'LOCAL' &&
            policy.target_version === '1.0.0' &&
            policy.package_version === '3217420' &&
            typeof policy.npc_range_enabled === 'boolean' &&
            policy.npc_range_authority === 'traced-before-configured-client-report' &&
            Number.isFinite(policy.player_position_tolerance_meters) &&
            policy.player_position_tolerance_meters >= 0,
        'Invalid LOCAL task condition event policy',
        ErrorCode.GameConfig,
    )
    return policy
}
validateTaskConditionEventPolicy(configuredPolicy)

function acknowledgedRangeNode(task, context) {
    const { graph, node } = context ?? {}
    ensure(
        graph?.config.id === task.task_id && node && task.nodes.includes(node) && node.client_before === true,
        'Task range has no acknowledged active node',
        ErrorCode.InvalidArgument,
    )
    return { graph, node }
}

function validateNpcRangeAuthority(c, task, data, context, policy, alreadyAccepted) {
    validateTaskConditionEventPolicy(policy)
    ensure(policy.npc_range_enabled, 'LOCAL task NPC range reporting is disabled', ErrorCode.FunctionClosed)
    if (alreadyAccepted >= 1) return
    ensure(task.client_trace === true, 'Task range is not the traced task', ErrorCode.InvalidArgument)
    const manifest = tableExportManifest(c.tables)
    ensure(
        manifest &&
            Object.values(manifest.packageVersions ?? {}).length > 0 &&
            Object.values(manifest.packageVersions).every((version) => version === policy.package_version),
        'Task NPC authority requires the current versioned table source',
        ErrorCode.GameConfig,
    )
    const { graph, node } = acknowledgedRangeNode(task, context)
    const matches = graph.npcs.filter((npc) => npc.createNpcId === data.listenObject)
    ensure(
        matches.length === 1 && matches[0].__type_TaskNpcOverrideData,
        'Task NPC range listener is not uniquely configured',
        ErrorCode.GameConfig,
    )
    const npc = matches[0]
    ensure(
        npc.sceneId === c.state.world.map_id,
        'Task NPC range listener is in another scene',
        ErrorCode.InvalidArgument,
    )
    ensure(
        npc.isAllTask === true || taskOverrideNodeIds(npc).includes(node.node_id),
        'Task NPC range listener is outside the active override scope',
        ErrorCode.InvalidArgument,
    )
    ensure(npc.isOverride === false, 'Overridden NPC range authority is not implemented', ErrorCode.FunctionClosed)
    const template = c.tables.find('worldmap_' + npc.sceneId, npc.npcId)
    ensure(template?.cityId === npc.sceneId, 'Task NPC range template is unavailable', ErrorCode.GameConfig)
    ensure(
        Number.isSafeInteger(template.spawnerId) && template.spawnerId > 0,
        'Invalid task NPC range spawner identity',
        ErrorCode.GameConfig,
    )
    const spawner = c.tables.find('world_spawner', template.spawnerId)
    const unit =
        spawner && Number.isSafeInteger(spawner.resourceId) && spawner.resourceId > 0
            ? c.tables.find('unit', spawner.resourceId)
            : null
    ensure(
        spawner?.basicType === 1 &&
            spawner.objectType === 2 &&
            unit?.id === spawner.resourceId &&
            typeof unit.model === 'string' &&
            unit.model.length > 0,
        'Task NPC range resource chain is unavailable',
        ErrorCode.GameConfig,
    )
    // LOCAL compatibility: this verifies the registered metadata scope, not a
    // runtime UUID or NPC coordinate. The current client owns this NPC motion
    // and reports the scoped range crossing; no player/spawn pose substitutes it.
}

// Current TaskRangeAreaUtility0602e729 -> IsInArea06024849. Despite its
// Circle enum name, shape1 uses a full Vector3 squared distance, strictly <r².
export function taskRangeContains(data, positionCm, toleranceMeters = 0) {
    ensure(
        Number.isFinite(toleranceMeters) && toleranceMeters >= 0,
        'Invalid LOCAL task position tolerance',
        ErrorCode.GameConfig,
    )
    ensure(vector(data.position) && vector(data.scale), 'Invalid task range geometry', ErrorCode.GameConfig)
    ensure(
        vector(positionCm) && Object.values(positionCm).every(Number.isSafeInteger),
        'Invalid saved task range position',
        ErrorCode.GameConfig,
    )
    const point = Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, f(positionCm[axis] / 100)]))
    const center = Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, f(data.position[axis])]))
    const scale = Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, Math.abs(f(data.scale[axis]))]))
    const dx = f(point.x - center.x),
        dy = f(point.y - center.y),
        dz = f(point.z - center.z)
    const tolerance = f(toleranceMeters),
        radius = f(scale.x + tolerance)
    if (data.shapeType === 1) return f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz)) < f(radius * radius)
    ensure(
        [2, 3].includes(data.shapeType),
        'Task range shape requires an authoritative area definition',
        ErrorCode.FunctionClosed,
    )
    const nativeBottom = f(center.y - f(scale.y * 0.5)),
        bottom = f(nativeBottom - tolerance),
        top = f(f(nativeBottom + scale.y) + tolerance)
    if (scale.y > 0 && (point.y < bottom || point.y > top)) return false
    if (data.shapeType === 3) return f(f(dx * dx) + f(dz * dz)) < f(radius * radius)
    const halfX = f(f(scale.x / 2) + tolerance),
        halfZ = f(f(scale.z / 2) + tolerance)
    return (
        point.x >= f(center.x - halfX) &&
        point.x <= f(center.x + halfX) &&
        point.z >= f(center.z - halfZ) &&
        point.z <= f(center.z + halfZ)
    )
}

export function validateTaskRangeEvent(c, task, data, alreadyAccepted, context, policy = configuredPolicy) {
    ensure(Number.isSafeInteger(data.count) && data.count > 0, 'Invalid task range count', ErrorCode.GameConfig)
    ensure(
        data.count === 1 &&
            data.listenOnlyOnceIN === true &&
            data.listenOnlyOnceOut === false &&
            data.softLockNotify === 0,
        'Task range mode needs a verified event lifecycle',
        ErrorCode.FunctionClosed,
    )
    if (data.listenObject !== -1) {
        ensure(
            Number.isSafeInteger(data.listenObject) && data.listenObject > 0,
            'Invalid task NPC range listener',
            ErrorCode.GameConfig,
        )
        validateNpcRangeAuthority(c, task, data, context, policy, alreadyAccepted)
        return
    }
    validateTaskConditionEventPolicy(policy)
    if (alreadyAccepted >= 1) return
    ensure(task.client_trace === true, 'Task range is not the traced task', ErrorCode.InvalidArgument)
    acknowledgedRangeNode(task, context)
    ensure(
        // Explicit LOCAL sampling tolerance. The pure geometry default is zero.
        taskRangeContains(data, c.state.world.pos, policy.player_position_tolerance_meters),
        'Controlled hero is outside the configured task range',
        ErrorCode.InvalidArgument,
    )
}

export function validateTaskPlayableStepEvent(c, data, alreadyAccepted = 0) {
    ensure(
        [data.playableID, data.sceneID, data.step].every((value) => Number.isSafeInteger(value) && value > 0),
        'Invalid task playable step configuration',
        ErrorCode.GameConfig,
    )
    const config = c.tables.find('playable', data.playableID)
    ensure(config, 'Task playable configuration unavailable', ErrorCode.GameConfig)
    ensure(c.state.world.map_id === data.sceneID, 'Task playable step is in a different map', ErrorCode.InvalidArgument)
    if (alreadyAccepted >= 1) return
    const run = c.state.playableRuns?.[data.playableID],
        finished = c.state.playableFinishes?.[data.playableID]
    if (run)
        ensure(
            run.play_id === data.playableID &&
                Number.isSafeInteger(run.map_id) &&
                run.map_id > 0 &&
                [1, 2, 3].includes(run.status) &&
                Number.isSafeInteger(run.finish_step) &&
                run.finish_step >= 0,
            'Invalid saved task playable progress',
            ErrorCode.GameConfig,
        )
    if (finished)
        ensure(
            finished.play_id === data.playableID && Number.isSafeInteger(finished.map_id) && finished.map_id > 0,
            'Invalid saved task playable completion',
            ErrorCode.GameConfig,
        )
    const complete = finished?.play_id === data.playableID && finished.map_id === data.sceneID
    const progressed =
        run?.play_id === data.playableID &&
        run.map_id === data.sceneID &&
        [1, 2, 3].includes(run.status) &&
        Number.isSafeInteger(run.finish_step) &&
        run.finish_step >= data.step
    ensure(
        complete || progressed,
        'Playable has no matching server step or completion record',
        ErrorCode.InvalidArgument,
    )
}
