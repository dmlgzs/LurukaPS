import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskNodeFinishedCurrentAttempt } from './task-node-status.js'
import { taskPackageEligible } from './task-package-scope.js'
import { grantWorldPoint } from './world-point-rewards.js'

// Current EWorldObjectType, mapSievingType and WorldInteract.InteractType.
// These describe a source binding, never GM/map-open permission.
const kinds = new Map([
    [21, { marker: 2, action: 13 }],
    [22, { marker: 44, action: 136 }],
])
const uint = (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff
function rows(tables, name) {
    const values = tables.get(name)
    ensure(Array.isArray(values), `Natural point source table unavailable: ${name}`, ErrorCode.GameConfig)
    return values
}
function row(tables, name, id, code = ErrorCode.GameConfig) {
    const matches = rows(tables, name).filter((value) => value?.id === id)
    ensure(matches.length <= 1, `Natural point source identity duplicated: ${name}/${id}`, ErrorCode.GameConfig)
    ensure(matches.length === 1, `Natural point source identity unavailable: ${name}/${id}`, code)
    return matches[0]
}
function condition(tables, state, value, depth = 0) {
    ensure(
        typeof value === 'string' && value.length > 0 && depth < 4,
        'Natural point condition malformed',
        ErrorCode.GameConfig,
    )
    return value.split('|').every((token) => {
        const parts = token.split('#')
        ensure(
            parts.every((part) => /^\d+$/.test(part)),
            'Natural point condition arguments malformed',
            ErrorCode.GameConfig,
        )
        const [kind, a, b, ...extra] = parts.map(Number)
        ensure(
            !extra.length && uint(kind) && uint(a),
            'Natural point condition arguments invalid',
            ErrorCode.GameConfig,
        )
        const config = row(tables, 'common_condition', kind)
        const expectedName = new Map([
            [12042, 'SystemUnlock'],
            [12045, 'CompleteTaskStep'],
            [2004, 'Level'],
        ]).get(kind)
        if (expectedName)
            ensure(
                config.name === expectedName,
                'Natural point condition source identity changed',
                ErrorCode.GameConfig,
            )
        if (kind === 12042 && config.name === 'SystemUnlock') {
            ensure(parts.length === 2, 'Natural point system condition malformed', ErrorCode.GameConfig)
            const system = row(tables, 'system_unlock', a)
            const formal = taskPackageEligible({ isReviewMode_tishen: 0 })
            const configured = formal ? system.unlockCondi : system.reviewModeCondi_tishen
            return condition(tables, state, configured, depth + 1)
        }
        if (kind === 12045 && config.name === 'CompleteTaskStep') {
            ensure(parts.length === 3 && uint(b), 'Natural point task condition malformed', ErrorCode.GameConfig)
            return taskNodeFinishedCurrentAttempt(state, a, b)
        }
        if (kind === 2004 && config.name === 'Level') {
            ensure(parts.length === 2, 'Natural point level condition malformed', ErrorCode.GameConfig)
            const level = state.player?.basic_info?.lv
            ensure(uint(level), 'Natural point player level malformed', ErrorCode.GameConfig)
            return level >= a
        }
        ensure(false, `Natural point condition unsupported: ${kind}`, ErrorCode.FunctionClosed)
    })
}

export function resolveWorldPointActivation(tables, state, object, spawner, input) {
    ensure(
        uint(object?.id) && Number.isInteger(spawner?.objectType) && spawner.objectType >= 0,
        'Natural point object source malformed',
        ErrorCode.GameConfig,
    )
    const kind = kinds.get(spawner.objectType)
    if (!kind) return null
    const map = state.world?.map_id
    ensure(uint(map) && object.cityId === map, 'Natural point is outside current map', ErrorCode.CannotInteract)
    ensure(
        input.obj?.obj_id === object.id && input.obj.complete === true && (input.interact_type ?? 0) === 0,
        'Natural point activation request differs',
        ErrorCode.CannotInteract,
    )
    const currentObject = row(tables, `worldmap_${map}`, object.id)
    const currentSpawner = row(tables, 'world_spawner', currentObject.spawnerId, ErrorCode.SpawnerConfIsNull)
    ensure(
        currentObject.cityId === map &&
            currentObject.expandId === object.expandId &&
            currentObject.filterMark === object.filterMark &&
            currentSpawner.id === spawner.id &&
            currentSpawner.objectType === spawner.objectType,
        'Natural point object binding changed',
        ErrorCode.GameConfig,
    )
    const marks = rows(tables, 'world_filter_mark').filter(
        (mark) => mark.worldId === map && mark.worldmapId === object.id,
    )
    ensure(marks.length <= 1, 'Natural point current map marker duplicated', ErrorCode.GameConfig)
    ensure(marks.length === 1, 'Natural point has no unique current map marker', ErrorCode.FunctionClosed)
    const mark = marks[0]
    ensure(
        mark.markType === kind.marker &&
            uint(mark.id) &&
            mark.id === object.filterMark &&
            uint(mark.posId) &&
            mark.posId === object.expandId &&
            typeof mark.icon === 'string' &&
            mark.icon.split('|')[0].trim(),
        'Natural point map marker binding malformed',
        ErrorCode.GameConfig,
    )
    const point = row(tables, 'world_borthpos', mark.posId, ErrorCode.NotFoundBirthPoint)
    row(tables, 'world_city', map, ErrorCode.NoWorldCityConf)
    ensure(
        point.cityId === map && point.type === 2 && [0, 1].includes(point.lockPoint),
        'Natural point destination binding malformed',
        ErrorCode.GameConfig,
    )
    const actions = rows(tables, 'world_interact').filter((interact) => interact.interactAction === kind.action)
    ensure(
        actions.length === 1 && uint(actions[0].id),
        'Natural point activation action is not unique',
        ErrorCode.GameConfig,
    )
    const action = actions[0]
    ensure(input.interact_id === action.id, 'Natural point activation interaction differs', ErrorCode.CannotInteract)
    return {
        pointId: point.id,
        mapId: map,
        objectId: object.id,
        markerId: mark.id,
        interactId: action.id,
        actionId: kind.action,
        conditions: action.interactCond,
    }
}

// Caller runs this only inside its existing first full-claim branch, AFTER
// original range and visibility checks. Old complete-without-point recovery
// is intentionally outside this capability; no fake reward or task write.
export function activateWorldPoint(tables, state, object, spawner, input) {
    const activation = resolveWorldPointActivation(tables, state, object, spawner, input)
    if (!activation) return null
    ensure(
        condition(tables, state, activation.conditions),
        'Natural point system or task is locked',
        ErrorCode.SystemLock,
    )
    const revision = state.worldPointRewardRevision ?? 0
    ensure(
        Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER,
        'Natural point reward revision malformed',
        ErrorCode.GameConfig,
    )
    return { ...activation, added: grantWorldPoint(tables, state, activation.pointId) }
}
