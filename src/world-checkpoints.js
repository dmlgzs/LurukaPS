import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { taskBirthPoint } from './task-scenes.js'

function checkpoint(tables, state, id) {
    ensure(Number.isSafeInteger(id) && id > 0, 'Invalid checkpoint ID', ErrorCode.ParamError)
    const point = taskBirthPoint(tables, id)
    ensure(point.type === 4, 'Birth point is not a checkpoint', ErrorCode.NotFoundBirthPoint)
    ensure(point.cityId === state.world.map_id, 'Checkpoint belongs to another map', ErrorCode.NotSameCity)
    return point
}

function source(state, info = {}, opening = false) {
    const type = info.checkpoint_type ?? 0,
        args = info.args ?? []
    ensure([0, 1, 2].includes(type), 'Invalid checkpoint source type', ErrorCode.ParamError)
    ensure(Array.isArray(args) && args.length <= 1, 'Invalid checkpoint source arguments', ErrorCode.ParamError)
    ensure(
        args.every((v) => Number.isSafeInteger(v) && v >= 0 && v <= 0x7fffffff),
        'Invalid checkpoint owner',
        ErrorCode.ParamError,
    )
    const owner = args[0] ?? 0
    if (type === 0)
        ensure(owner === 0, 'World checkpoint must not impersonate a task or playable', ErrorCode.ParamError)
    else {
        ensure(owner > 0, 'Missing checkpoint source owner', ErrorCode.ParamError)
        if (opening && type === 1) {
            const run = state.playableRuns?.[owner]
            ensure(
                run?.map_id === state.world.map_id && run.status === 1,
                'Checkpoint playable is not running',
                ErrorCode.PlayableNotStart,
            )
        }
        if (opening && type === 2)
            ensure(
                state.tasks?.some((task) => task.task_id === owner),
                'Checkpoint task is not active',
                ErrorCode.PlayerTaskNotFound,
            )
    }
    return { key: `${type}:${owner}`, checkpoint_type: type, args: owner ? [owner] : [] }
}

export function checkpointSnapshot(state) {
    const map = state.worldCheckpoints?.[state.world.map_id] ?? {}
    return {
        checkpoint_ids: Object.keys(map)
            .filter((id) => Object.keys(map[id].sources ?? {}).length)
            .map(Number)
            .sort((a, b) => a - b),
    }
}

export function openCheckpoint(tables, state, request) {
    const point = checkpoint(tables, state, request.checkpoint_id),
        infos = request.checkpoint_infos ?? []
    ensure(Array.isArray(infos) && infos.length <= 32, 'Too many checkpoint sources', ErrorCode.ParamError)
    const sources = (infos.length ? infos : [{}]).map((info) => source(state, info, true))
    const maps = (state.worldCheckpoints ??= {}),
        map = (maps[point.cityId] ??= {}),
        record = (map[point.id] ??= { sources: {} })
    for (const { key, ...value } of sources) record.sources[key] = value
    return { u32s: checkpointSnapshot(state).checkpoint_ids }
}

// Local policy: a checkpoint can have independent World/Playable/Task owners;
// Close removes only its matching source, so one graph cannot close another's
// checkpoint. TODO: verify official reference lifetime and automatic task/run
// cleanup. Do not infer task completion or teleport from a checkpoint request.
export function closeCheckpoint(tables, state, request) {
    const point = checkpoint(tables, state, request.checkpoint_id),
        owner = source(state, request.checkpoint_info),
        map = state.worldCheckpoints?.[point.cityId],
        record = map?.[point.id]
    if (record) {
        delete record.sources[owner.key]
        if (!Object.keys(record.sources).length) delete map[point.id]
    }
    return { u32s: checkpointSnapshot(state).checkpoint_ids }
}
