import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const positive = (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff
const transferKinds = new Map([
    [21, 2],
    [22, 44],
])
function rows(tables, name) {
    const value = tables.get(name)
    ensure(Array.isArray(value), 'World point source table is malformed: ' + name, ErrorCode.GameConfig)
    return value
}
function one(tables, name, id, code = ErrorCode.GameConfig) {
    const found = rows(tables, name).filter((row) => row?.id === id)
    ensure(found.length <= 1, 'World point source identity is duplicated: ' + name, ErrorCode.GameConfig)
    ensure(found.length === 1, 'World point source identity is unavailable: ' + name, code)
    return found[0]
}
// Read-only default-point admission for the current same-scene transport.
// It grants no point, reward, discovery, system or GM/map-open permission.
export function currentDefaultTransferPoint(tables, state, point) {
    const map = state.world?.map_id
    ensure(
        positive(map) &&
            positive(point?.id) &&
            positive(point.cityId) &&
            Number.isInteger(point.type) &&
            [0, 1].includes(point.lockPoint),
        'World point source identity is malformed',
        ErrorCode.GameConfig,
    )
    if (point.cityId !== map || point.type !== 2 || point.lockPoint !== 0) return null
    const current = one(tables, 'world_borthpos', point.id, ErrorCode.NotFoundBirthPoint)
    one(tables, 'world_city', map, ErrorCode.NoWorldCityConf)
    ensure(
        current.cityId === point.cityId && current.type === point.type && current.lockPoint === point.lockPoint,
        'World point destination source changed',
        ErrorCode.GameConfig,
    )
    const marks = rows(tables, 'world_filter_mark').filter(
            (mark) => mark?.worldId === map && mark.posId === point.id && [2, 44].includes(mark.markType),
        ),
        candidates = []
    for (const mark of marks) {
        ensure(
            positive(mark.id) && positive(mark.worldmapId),
            'World point map marker is malformed',
            ErrorCode.GameConfig,
        )
        one(tables, 'world_filter_mark', mark.id)
        const object = one(tables, 'worldmap_' + map, mark.worldmapId),
            spawner = one(tables, 'world_spawner', object.spawnerId, ErrorCode.SpawnerConfIsNull)
        if (!transferKinds.has(spawner.objectType)) continue
        ensure(
            transferKinds.get(spawner.objectType) === mark.markType &&
                object.cityId === map &&
                object.filterMark === mark.id &&
                object.expandId === current.id,
            'World point marker/entity/destination binding differs',
            ErrorCode.GameConfig,
        )
        candidates.push({
            pointId: current.id,
            mapId: map,
            markerId: mark.id,
            objectId: object.id,
            spawnerId: spawner.id,
            objectType: spawner.objectType,
        })
    }
    ensure(candidates.length <= 1, 'Default world point has ambiguous current source bindings', ErrorCode.GameConfig)
    return candidates[0] ?? null
}
