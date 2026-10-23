import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configTime } from './shops.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { Tables } from './player.js'
const routeData = JSON.parse(fs.readFileSync(new URL('../configs/abyss-routes.json', import.meta.url)))
const policy = JSON.parse(fs.readFileSync(new URL('../configs/abyss-policy.json', import.meta.url)))
const directory = fileURLToPath(new URL('../configs/abyss-tables/', import.meta.url)),
    source = JSON.parse(fs.readFileSync(new URL('../configs/abyss-tables/source.json', import.meta.url))),
    scoped = new Set(source.tables.map((x) => x.name)),
    complete = new Set([
        'abbys_mode',
        'abbys_level',
        'abbys_time',
        'abbys_reward',
        'abbys_buff',
        'abbys_buff_group',
        'abbys_direct_pass',
    ]),
    cache = new WeakMap()
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export function abyssTables(external) {
    if (external.abyss_scope) return external
    if (cache.has(external)) return cache.get(external)
    const current = new Tables(directory),
        merged = new Map(),
        indices = new Map(),
        adapter = {
            abyss_scope: true,
            abyss_directory: directory,
            dir: external.dir,
            get(name) {
                if (!scoped.has(name)) return external.get(name)
                if (complete.has(name) || name.startsWith('worldmap_')) return current.get(name)
                if (!merged.has(name)) {
                    const rows = new Map(external.get(name).map((x) => [x.id, x]))
                    for (const row of current.get(name)) rows.set(row.id, row)
                    merged.set(name, [...rows.values()])
                }
                return merged.get(name)
            },
            find(name, id) {
                if (!scoped.has(name)) return external.find(name, id)
                if (!indices.has(name)) indices.set(name, new Map(this.get(name).map((x) => [x.id, x])))
                return indices.get(name).get(Number(id))
            },
            position(point) {
                return Tables.prototype.position.call(this, point)
            },
        }
    cache.set(external, adapter)
    return adapter
}
export function abyssRotation(tables, now) {
    const rows = tables.get('abbys_time').filter((x) => configTime(x.startTime) <= now && now < configTime(x.endTime))
    ensure(rows.length <= 1, 'Ambiguous abyss rotation configuration', ErrorCode.GameConfig)
    return rows[0] ?? null
}
export function abyssModeLevels(tables, mode, now) {
    ensure([1, 2, 3].includes(mode), 'Invalid abyss mode', ErrorCode.AbyssInvalidMode)
    const row = tables.find('abbys_mode', mode)
    ensure(row, 'Abyss mode configuration unavailable', ErrorCode.AbyssInvalidMode)
    const rotation = mode === 3 ? abyssRotation(tables, now) : null
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
