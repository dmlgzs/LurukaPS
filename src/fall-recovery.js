import { createHash } from 'node:crypto'
import policy from '../configs/fall-recovery-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskBirthPoint } from './task-scenes.js'
import { clearSceneMount } from './mounts.js'

const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const position = (value) =>
    object(value) && ['x', 'y', 'z'].every((key) => Number.isInteger(value[key]) && Math.abs(value[key]) < 100000000)
function time(value, code = ErrorCode.ParamError) {
    if (value === undefined) return '0'
    ensure(
        typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)),
        'Invalid movement timestamp',
        code,
    )
    const text = String(value)
    ensure(/^(0|[1-9][0-9]*)$/.test(text) && BigInt(text) < 1n << 64n, 'Invalid movement timestamp', code)
    return text
}
function session(c) {
    const token = c.connectionKey ?? c.combatSessionId
    ensure(typeof token === 'string' && token.length > 0, 'Fall recovery session unavailable', ErrorCode.InvalidLogic)
    return createHash('sha256').update(token).digest('hex')
}
function saved(world) {
    const value = world.fall_recovery
    if (value === undefined) return null
    ensure(
        object(value) &&
            value.version === 1 &&
            uint(value.generation) &&
            value.generation > 0 &&
            uint(value.map_id) &&
            value.map_id > 0 &&
            typeof value.latest_timestamp === 'string' &&
            typeof value.minimum_timestamp === 'string' &&
            (value.session === null || /^[a-f0-9]{64}$/.test(value.session)),
        'Saved fall recovery scope is malformed',
        ErrorCode.GameConfig,
    )
    time(value.latest_timestamp, ErrorCode.GameConfig)
    time(value.minimum_timestamp, ErrorCode.GameConfig)
    ensure(
        BigInt(value.minimum_timestamp) <= BigInt(value.latest_timestamp) &&
            (value.ground === undefined || object(value.ground)) &&
            (value.pending === undefined ||
                (object(value.pending) &&
                    object(value.pending.target) &&
                    ['current-ground', 'active-checkpoint', 'entry-birth', 'scene-main-birth'].includes(
                        value.pending.source,
                    ))),
        'Saved fall recovery destination is malformed',
        ErrorCode.GameConfig,
    )
    for (const entry of [value.ground, value.pending?.target])
        if (entry)
            ensure(
                position(entry.pos) && uint(entry.angle) && uint(entry.area_id),
                'Saved fall destination is malformed',
                ErrorCode.GameConfig,
            )
    if (value.ground) {
        const stamp = time(value.ground.timestamp, ErrorCode.GameConfig)
        ensure(
            stamp !== '0' && BigInt(stamp) <= BigInt(value.latest_timestamp),
            'Saved grounded timestamp is malformed',
            ErrorCode.GameConfig,
        )
    }
    return value
}
function fresh(old, map, key) {
    const generation = old ? old.generation + (old.session === null ? 0 : 1) : 1
    ensure(uint(generation) && generation > 0, 'Fall recovery generation overflow', ErrorCode.GameConfig)
    return { version: 1, generation, map_id: map, session: key, latest_timestamp: '0', minimum_timestamp: '0' }
}
function scope(c) {
    const old = saved(c.state.world),
        key = session(c)
    return old?.map_id === c.state.world.map_id && old.session === key ? old : fresh(old, c.state.world.map_id, key)
}
// Only full server transfers reset the snapshot. Existing source objects are
// replaced, never edited through the movement fork's shared nested references.
export function resetFallRecoveryScope(state) {
    const old = saved(state.world)
    if (!old) return
    ensure(old.generation < 0xffffffff, 'Fall recovery generation overflow', ErrorCode.GameConfig)
    state.world.fall_recovery = {
        version: 1,
        generation: old.generation + 1,
        map_id: state.world.map_id,
        session: null,
        latest_timestamp: '0',
        minimum_timestamp: '0',
    }
}
export function acceptFallRecoveryMovement(c, move) {
    const info = move.info,
        stamp = time(info.timestamp)
    if (!c.state.world.fall_recovery && !(info.is_ground === 1 && stamp !== '0')) return true
    const current = scope(c),
        minimum = BigInt(current.minimum_timestamp)
    if (minimum > 0n && (stamp === '0' || BigInt(stamp) <= minimum)) return false
    if (stamp === '0') return true
    const next = { ...current },
        latest = BigInt(current.latest_timestamp)
    if (BigInt(stamp) > latest) next.latest_timestamp = stamp
    if (info.is_ground === 1 && BigInt(stamp) > latest) {
        next.ground = {
            pos: { ...info.pos },
            angle: info.angle ?? 0,
            area_id: info.area_id ?? c.state.world.area_id ?? 0,
            timestamp: stamp,
            actor_guid: move.uuid,
        }
        delete next.pending
    }
    c.state.world.fall_recovery = next
    return true
}
function eligibleCheckpoints(c) {
    const records = c.state.worldCheckpoints?.[c.state.world.map_id] ?? {}
    ensure(object(records), 'Saved checkpoint collection is malformed', ErrorCode.GameConfig)
    const result = []
    for (const [id, record] of Object.entries(records)) {
        ensure(object(record?.sources), 'Saved checkpoint sources are malformed', ErrorCode.GameConfig)
        const eligible = Object.values(record.sources).some((source) => {
            ensure(
                object(source) &&
                    [0, 1, 2].includes(source.checkpoint_type) &&
                    Array.isArray(source.args) &&
                    source.args.length <= 1 &&
                    source.args.every(uint),
                'Saved checkpoint source is malformed',
                ErrorCode.GameConfig,
            )
            const owner = source.args?.[0] ?? 0
            ensure(
                source.checkpoint_type === 0 ? owner === 0 : owner > 0,
                'Saved checkpoint owner is malformed',
                ErrorCode.GameConfig,
            )
            if (source.checkpoint_type === 0) return true
            if (source.checkpoint_type === 1)
                return (
                    c.state.playableRuns?.[owner]?.map_id === c.state.world.map_id &&
                    c.state.playableRuns[owner].status === 1
                )
            if (source.checkpoint_type === 2) return c.state.tasks?.some((task) => task.task_id === owner)
            return false
        })
        if (eligible) {
            const point = taskBirthPoint(c.tables, Number(id), c.state.world.map_id)
            ensure(point.type === 4, 'Fall checkpoint configuration is not a checkpoint', ErrorCode.GameConfig)
            result.push(point)
        }
    }
    return result
}
function fallback(c) {
    const points = eligibleCheckpoints(c),
        origin = c.state.world.pos
    ensure(position(origin), 'Current fall position is malformed', ErrorCode.GameConfig)
    const distance = (point) => {
        const target = c.tables.position(point).pos,
            dx = BigInt(target.x) - BigInt(origin.x),
            dz = BigInt(target.z) - BigInt(origin.z)
        return dx * dx + dz * dz
    }
    points.sort((a, b) => {
        const x = distance(a),
            y = distance(b)
        return x < y ? -1 : x > y ? 1 : a.id - b.id
    })
    if (points.length) return { target: c.tables.position(points[0]), source: 'active-checkpoint' }
    if (c.state.world.point_id > 0) {
        try {
            return {
                target: c.tables.position(taskBirthPoint(c.tables, c.state.world.point_id, c.state.world.map_id)),
                source: 'entry-birth',
            }
        } catch (error) {
            if (error.code !== ErrorCode.NotFoundBirthPoint) throw error
        }
    }
    return { target: c.tables.position(taskBirthPoint(c.tables, 0, c.state.world.map_id)), source: 'scene-main-birth' }
}
export function recoverFallPosition(c, settings = policy) {
    ensure(
        settings?.version === 1 &&
            settings.position === 'current-scope-last-ground' &&
            settings.fallback === 'active-checkpoint-entry-main-birth' &&
            settings.health === 'preserve' &&
            settings.officially_verified === false,
        'Fall recovery policy unavailable',
        ErrorCode.GameConfig,
    )
    const current = scope(c),
        selected = current.pending
            ? { target: current.pending.target, source: current.pending.source }
            : current.ground
              ? { target: current.ground, source: 'current-ground' }
              : fallback(c)
    ensure(
        position(selected.target.pos) && uint(selected.target.angle) && uint(selected.target.area_id),
        'Fall recovery target unavailable',
        ErrorCode.GameConfig,
    )
    const next = {
        ...current,
        minimum_timestamp: current.pending ? current.minimum_timestamp : current.latest_timestamp,
        pending: {
            source: selected.source,
            target: {
                pos: { ...selected.target.pos },
                angle: selected.target.angle,
                area_id: selected.target.area_id,
                ...(selected.target.point_id ? { point_id: selected.target.point_id } : {}),
            },
        },
    }
    c.state.world.fall_recovery = next
    clearSceneMount(c.state)
    Object.assign(c.state.world, next.pending.target)
    return { source: selected.source, duplicate: !!current.pending }
}
