import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { WorldObjectCatalog } from './world-objects.js'
import policy from '../configs/resource-building-progress-policy.json' with { type: 'json' }
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff,
    positive = (n) => uint(n) && n > 0,
    cache = new WeakMap()
const vector = (value, delimiter) => {
    const parts = String(value).split(delimiter),
        result = parts.map(Number)
    ensure(
        parts.every((part) => /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(part)),
        'Invalid resource building numeric vector',
        ErrorCode.GameConfig,
    )
    ensure(
        result.length === 3 && result.every(Number.isFinite),
        'Invalid resource building area vector',
        ErrorCode.GameConfig,
    )
    return result
}
function inside(point, area) {
    const origin = vector(area.areaPos, '|'),
        vertices = String(area.vertices)
            .split('|')
            .map((v) => vector(v, '#'))
    ensure(
        vertices.length >= 3 && Number.isFinite(area.height) && area.height >= 0,
        'Invalid resource building area polygon',
        ErrorCode.GameConfig,
    )
    if (point[1] < origin[1] || point[1] > origin[1] + area.height) return false
    let hits = 0,
        previous = vertices.at(-1).map((v, i) => v + origin[i])
    for (const vertex of vertices) {
        const current = vertex.map((v, i) => v + origin[i])
        if (previous[2] !== current[2]) {
            const t = (point[2] - previous[2]) / (current[2] - previous[2])
            if (t > 0 && t <= 1 && previous[0] + (current[0] - previous[0]) * t >= point[0]) hits++
        }
        previous = current
    }
    return hits % 2 === 1
}
function model(tables) {
    if (cache.has(tables)) return cache.get(tables)
    ensure(
        policy.version === 1 &&
            policy.officiallyVerified === false &&
            policy.source === 'retained-repaired-world-collection' &&
            policy.location === 'unique-scene-group-point-in-configured-area-polygon' &&
            policy.areaSemantics === 'inclusion-not-exclusive-primary-region',
        'Invalid resource building progress policy',
        ErrorCode.GameConfig,
    )
    const worlds = tables.get('home_collection_world'),
        domains = new Map(tables.get('domain').map((r) => [r.domainId, r])),
        areas = new Map(tables.get('world_area').map((r) => [r.id, r])),
        objects = new WorldObjectCatalog(tables),
        groups = new Map(),
        byId = new Map(),
        buildings = new Map(tables.get('home_building_collection').map((row) => [row.id, row]))
    for (const world of worlds) {
        const domain = domains.get(world.domainId)
        ensure(
            positive(world.id) && positive(world.groupId) && domain && positive(domain.sceneId),
            'Invalid resource building world identity',
            ErrorCode.GameConfig,
        )
        ensure(!byId.has(world.id), 'Duplicate resource building collection identity', ErrorCode.GameConfig)
        byId.set(world.id, world)
        const key = domain.sceneId + ':' + world.groupId
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(world)
    }
    const result = { areas, objects, groups, byId, buildings }
    cache.set(tables, result)
    return result
}
function selected(tables, tokens) {
    if (
        !Array.isArray(tokens) ||
        tokens.length !== 5 ||
        tokens[0] !== 12016 ||
        !tokens.slice(1).every(positive) ||
        tokens[4] !== 1
    )
        return null
    const [, scene, areaId, group] = tokens,
        data = model(tables),
        matches = data.groups.get(scene + ':' + group),
        area = data.areas.get(areaId)
    if (!matches || matches.length !== 1 || !area || area.sceneId !== scene) return null
    const world = matches[0]
    if (world.type !== 1) return null
    const raw = data.objects.find('worldmap_' + scene, world.worldMapObjectUnfixed)
    ensure(raw && raw.cityId === scene, 'Missing resource building world point', ErrorCode.GameConfig)
    return inside(vector(raw.position, '|'), area) ? world : null
}
export function resourceBuildingProgressRule(tables, tokens) {
    return !!selected(tables, tokens)
}
export function resourceBuildingProgressValue(tables, state, tokens, facts = new Map()) {
    const world = selected(tables, tokens)
    if (!world) return null
    const key = 'resource-building-unlocks'
    if (!facts.has(key)) {
        const entries = state.home?.worldCollections === undefined ? {} : state.home.worldCollections,
            data = model(tables),
            unlocked = new Set()
        ensure(
            entries && typeof entries === 'object' && !Array.isArray(entries),
            'Malformed resource building unlock state',
            ErrorCode.GameConfig,
        )
        for (const [savedKey, entry] of Object.entries(entries)) {
            const id = Number(savedKey),
                source = data.byId.get(id)
            ensure(
                positive(id) &&
                    String(id) === savedKey &&
                    source &&
                    entry &&
                    typeof entry === 'object' &&
                    !Array.isArray(entry) &&
                    entry.collect_id === id,
                'Invalid resource building saved collection identity',
                ErrorCode.GameConfig,
            )
            if (entry.build_id === undefined || entry.build_id === 0) continue
            const building = data.buildings.get(entry.build_id)
            ensure(
                positive(entry.build_id) &&
                    source.type === 1 &&
                    building &&
                    building.groupId === source.groupId &&
                    positive(building.level),
                'Invalid resource building repaired definition',
                ErrorCode.GameConfig,
            )
            // GUID is a presentation/instance field,not part of this location
            // predicate. Do not invent a new legacy/actor GUID migration here.
            unlocked.add(id)
        }
        facts.set(key, unlocked)
    }
    return facts.get(key).has(world.id) ? 1 : 0
}
