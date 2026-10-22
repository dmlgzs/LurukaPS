import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { WorldObjectCatalog } from './world-objects.js'
import { worldSearchVisible } from './world-search-visible.js'
import { spend } from './inventory.js'

const models = new WeakMap()
// WorldFilterMarkByTypeMarkTypes::.cctor (060213f0), not arbitrary item IDs.
const byType = new Set([22, 23, 25, 5, 26, 90])
class WorldDetectors {
    constructor(tables) {
        this.tables = tables
        this.world = new WorldObjectCatalog(tables)
        this.marks = tables.get('world_filter_mark')
        this.types = new Map()
        this.cache = new Map()
        for (const row of tables.get('playable_track')) {
            ensure(
                Number.isSafeInteger(row.markType) && Number.isSafeInteger(row.playableType) && row.playableType > 0,
                'Invalid detector object type mapping',
                ErrorCode.GameConfig,
            )
            if (!this.types.has(row.markType)) this.types.set(row.markType, new Set())
            this.types.get(row.markType).add(row.playableType)
        }
    }
    candidates(map, track) {
        const key = map + ':' + track
        if (this.cache.has(key)) return this.cache.get(key)
        // The client examines the current scene before the global scene zero,
        // and takes the first matching no-showIf template, preserving table order.
        const template = [map, 0]
            .flatMap((id) => this.marks.filter((r) => r.worldId === id))
            .find((r) => r.trackType === track && r.showIf === 0)
        let rows = []
        if (template && byType.has(template.markType)) {
            ensure(
                ![5, 26].includes(template.markType),
                'Detector NPC-interaction or reborn-object filter is not implemented',
                ErrorCode.FunctionClosed,
            )
            const types = this.types.get(template.markType) ?? new Set()
            rows = this.world
                .get('worldmap_' + map)
                .filter(
                    (r) =>
                        !r.referObject &&
                        r.isstory !== 1 &&
                        types.has(this.world.find('world_spawner', r.spawnerId)?.objectType),
                )
        } else {
            const ids = new Set(
                this.marks.filter((r) => r.worldId === map && r.trackType === track).map((r) => r.worldmapId),
            )
            rows = this.world.get('worldmap_' + map).filter((r) => ids.has(r.id) && !r.referObject && r.isstory !== 1)
        }
        const result = rows.map((row) => {
            const { spawner, pos } = this.world.object(map, row.id)
            return { row, spawner, pos }
        })
        this.cache.set(key, result)
        return result
    }
}
function model(tables) {
    if (!models.has(tables)) models.set(tables, new WorldDetectors(tables))
    return models.get(tables)
}
export function detectorDefinition(tables, itemId) {
    ensure(
        Number.isSafeInteger(itemId) && itemId > 0 && itemId <= 0xffffffff,
        'Invalid detector item ID',
        ErrorCode.ParamError,
    )
    const item = tables.find('common_item', itemId)
    ensure(item, 'Detector item configuration does not exist', ErrorCode.InvalidItem)
    ensure(item.useType === 18, 'Item is not a world detector', ErrorCode.ItemTypeCannotUse)
    const [map, track] = String(item.useFunction ?? '')
        .split('|')
        .map(Number)
    ensure(
        [map, track].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff),
        'Invalid detector destination or track type',
        ErrorCode.GameConfig,
    )
    return { item, map, track }
}
export function detectorTarget(tables, state, itemId, now) {
    const definition = detectorDefinition(tables, itemId),
        map = state.world.map_id
    ensure(map === definition.map, 'Detector cannot be used in this map', ErrorCode.UseItemLimitInMap)
    const stacks = state.player.sbag_infos.items.filter((i) => i.itemid === itemId && (!i.deadtime || i.deadtime > now))
    ensure(stacks.reduce((sum, i) => sum + i.itemnum, 0) > 0, 'Detector item is not owned', ErrorCode.ItemNotEnough)
    ensure(
        ['x', 'y', 'z'].every((axis) => Number.isFinite(state.world.pos?.[axis])),
        'Invalid saved detector origin',
        ErrorCode.GameConfig,
    )
    let nearest = null,
        best = Infinity
    for (const candidate of model(tables).candidates(map, definition.track)) {
        const { row, spawner, pos } = candidate,
            record = state.worldObjects?.[map + ':' + row.id]
        const playable = spawner.objectType === 101
        if (!worldSearchVisible(row, record, state, { ignoreCompletion: playable })) continue
        if (playable && (!row.expandId || state.playableFinishes?.[row.expandId]?.map_id === map)) continue
        // Native MapObjectDetect uses configured positions, not moved runtime
        // entity positions, and has no maximum range for this item operation.
        const distance = ['x', 'y', 'z'].reduce((n, axis) => n + (state.world.pos[axis] - pos[axis]) ** 2, 0)
        ensure(Number.isFinite(distance), 'Invalid detector distance', ErrorCode.GameConfig)
        if (distance < best || (distance === best && row.id < nearest.row.id)) {
            best = distance
            nearest = candidate
        }
    }
    return nearest?.row.id ?? 0
}
export function consumeDetector(c, itemId) {
    const items = spend(c.state, new Map([[itemId, 1]]), 0, c.now)
    c.pushBefore('CSProtoSyncPlayerData', { sbag_infos: { items } })
}
export function findUncompletedWorldObject(c, request) {
    const id = detectorTarget(c.tables, c.state, request.item_id, c.now)
    // BagManager's callback explicitly treats successful objId zero as a
    // failed search. A failed search must leave the detector in the inventory.
    if (id) consumeDetector(c, request.item_id)
    return { obj_id: id }
}
