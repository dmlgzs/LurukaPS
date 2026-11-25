import fs from 'node:fs'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { activeAbyssRotation } from './abyss-rotation.js'
const routeData = JSON.parse(fs.readFileSync(new URL('../configs/abyss-routes.json', import.meta.url)))
const policy = JSON.parse(fs.readFileSync(new URL('../configs/abyss-policy.json', import.meta.url)))
const cache = new WeakMap()
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export function abyssTables(external) {
    if (external.abyss_scope) return external
    if (!cache.has(external)) {
        const adapter = Object.create(external)
        adapter.abyss_scope = true
        adapter.abyss_directory = external.dir
        cache.set(external, adapter)
    }
    return cache.get(external)
}
export function abyssRotation(tables, now, policy) {
    return activeAbyssRotation(tables, now, policy)
}
export function abyssModeLevels(tables, mode, now, policy) {
    ensure([1, 2, 3].includes(mode), 'Invalid abyss mode', ErrorCode.AbyssInvalidMode)
    const row = tables.find('abbys_mode', mode)
    ensure(row, 'Abyss mode configuration unavailable', ErrorCode.AbyssInvalidMode)
    const rotation = mode === 3 ? abyssRotation(tables, now, policy) : null
    ensure(mode !== 3 || rotation, 'Abyss rotation is not open', ErrorCode.AbyssRotationChange)
    return { row, rotation, levels: ids(mode === 3 ? rotation.level : row.level) }
}
export function abyssRoute(tables, dungeonId) {
    const dungeon = tables.find('dungeon', dungeonId),
        route = routeData.routes.find((x) => x.dungeon_id === dungeonId)
    ensure(dungeon, 'Invalid abyss dungeon', ErrorCode.AbyssInvalidDungeonID)
    ensure(route, 'Abyss scene route remains ambiguous', ErrorCode.InstanceSceneConfNotExist)
    ensure(
        route.policy !== 'canonical_equivalent_scene' || policy.equivalentScenes === 'canonical',
        'Equivalent abyss route compatibility is disabled',
        ErrorCode.FunctionClosed,
    )
    const city = tables.find('world_city', route.map_id),
        point = tables.find('world_borthpos', route.point_id)
    ensure(
        city?.type === 26 && point?.cityId === city.id,
        'Abyss scene or entry configuration invalid',
        ErrorCode.InstanceSceneConfNotExist,
    )
    return { route, dungeon, point }
}
