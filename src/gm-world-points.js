import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Current 1.0 MapManager.GetAllTransferNode/GetAllSubTransferNode and
// mapSievingType; EWorldObjectType.TransferPointSmall/TransferPointSecondary.
const transferTypes = new Map([
    [2, 21],
    [44, 22],
])
const uint = (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff
function index(tables, name) {
    const rows = tables.get(name)
    ensure(Array.isArray(rows), `GM point table unavailable: ${name}`, ErrorCode.GameConfig)
    const result = new Map()
    for (const row of rows) {
        ensure(
            row && uint(row.id) && !result.has(row.id),
            `GM point table identity malformed: ${name}`,
            ErrorCode.GameConfig,
        )
        result.set(row.id, row)
    }
    return result
}
function coordinates(value, length, label) {
    ensure(
        typeof value === 'string' &&
            value.split('|').length === length &&
            value.split('|').every((part) => part.trim() !== '' && Number.isFinite(Number(part))),
        `GM point ${label} malformed`,
        ErrorCode.GameConfig,
    )
}

export function currentGmWorldPoints(tables) {
    const marks = index(tables, 'world_filter_mark')
    const points = index(tables, 'world_borthpos')
    const spawners = index(tables, 'world_spawner')
    const cities = index(tables, 'world_city')
    const maps = new Map()
    const bindings = []
    const displayOnly = []
    const selected = new Set()
    for (const mark of marks.values()) {
        if (!transferTypes.has(mark.markType)) continue
        ensure(
            uint(mark.worldId) && cities.has(mark.worldId),
            'GM point marker city unavailable',
            ErrorCode.NoWorldCityConf,
        )
        ensure(
            typeof mark.icon === 'string' && mark.icon.split('|')[0].trim(),
            'GM point marker icon unavailable',
            ErrorCode.GameConfig,
        )
        if (!maps.has(mark.worldId)) maps.set(mark.worldId, index(tables, `worldmap_${mark.worldId}`))
        const object = maps.get(mark.worldId).get(mark.worldmapId)
        ensure(object && object.cityId === mark.worldId, 'GM point marker object unavailable', ErrorCode.GameConfig)
        const spawner = spawners.get(object.spawnerId)
        ensure(spawner, 'GM point spawner unavailable', ErrorCode.SpawnerConfIsNull)
        const point = points.get(mark.posId)
        ensure(point, 'GM point destination unavailable', ErrorCode.NotFoundBirthPoint)
        ensure(cities.has(point.cityId), 'GM point destination city unavailable', ErrorCode.NoWorldCityConf)
        ensure([0, 1].includes(point.lockPoint), 'GM point lock state malformed', ErrorCode.GameConfig)
        coordinates(point.borthPoint, 6, 'destination coordinates')
        coordinates(object.position, 3, 'object coordinates')
        const binding = {
            pointId: point.id,
            mapId: mark.worldId,
            markId: mark.id,
            markType: mark.markType,
            objectId: object.id,
            spawnerId: spawner.id,
            objectType: spawner.objectType,
            locked: point.lockPoint === 1,
        }
        if (spawner.objectType !== transferTypes.get(mark.markType)) {
            // Native map markers also include inter-scene entrances. They are
            // display/transport destinations, not activatable star-vein objects.
            ensure(
                point.cityId !== mark.worldId,
                'GM point local marker object type unsupported',
                ErrorCode.FunctionClosed,
            )
            displayOnly.push({ ...binding, destinationMapId: point.cityId, reason: 'cross-scene-entrance' })
            continue
        }
        ensure(
            point.type === 2 &&
                point.cityId === mark.worldId &&
                object.expandId === point.id &&
                object.filterMark === mark.id,
            'GM point activation binding differs from map marker',
            ErrorCode.GameConfig,
        )
        ensure(!selected.has(point.id), 'GM point activation destination duplicated', ErrorCode.GameConfig)
        selected.add(point.id)
        bindings.push(binding)
    }
    ensure(bindings.length > 0, 'GM point activation catalogue unavailable', ErrorCode.FunctionClosed)
    bindings.sort((a, b) => a.pointId - b.pointId)
    displayOnly.sort((a, b) => a.markId - b.markId)
    return { pointIds: bindings.map((row) => row.pointId), bindings, displayOnly }
}

export function unlockCurrentGmWorldPoints(tables, state) {
    const catalogue = currentGmWorldPoints(tables)
    const previous = state.world?.points
    ensure(
        state.world && Array.isArray(previous) && previous.every(uint),
        'GM unlocked point state malformed',
        ErrorCode.GameConfig,
    )
    const owned = new Set(previous)
    const added = catalogue.pointIds.filter((id) => !owned.has(id))
    const points = [...new Set([...previous, ...added])].sort((a, b) => a - b)
    // GM caller owns explicit 9105 delivery; do not mark natural world-object
    // completion, grant rewards or increment reward-producer sync revisions.
    state.world.points = points
    return { added, points }
}
