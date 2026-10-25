import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/world-collection-progress-policy.json' with { type: 'json' }

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
const models = new WeakMap()
function model(tables) {
    if (!models.has(tables)) {
        const worlds = new Map(),
            domains = new Map(tables.get('domain').map((row) => [row.domainId, row])),
            buildings = new Map(tables.get('home_building_collection').map((row) => [row.id, row])),
            scenes = new Set()
        for (const world of tables.get('home_collection_world')) {
            const domain = domains.get(world.domainId)
            ensure(
                uint(world.id) &&
                    world.id > 0 &&
                    !worlds.has(world.id) &&
                    domain &&
                    uint(domain.sceneId) &&
                    domain.sceneId > 0,
                'Invalid world collection progress configuration',
                ErrorCode.GameConfig,
            )
            worlds.set(world.id, { ...world, sceneId: domain.sceneId })
            scenes.add(domain.sceneId)
        }
        models.set(tables, { worlds, buildings, scenes })
    }
    return models.get(tables)
}
export function worldCollectionProgressRule(tables, tokens) {
    if (!Array.isArray(tokens)) return false
    const [kind, scene, domain, type, count] = tokens
    return (
        kind === 13039 &&
        tokens.length === 5 &&
        uint(scene) &&
        (scene === 0 || model(tables).scenes.has(scene)) &&
        domain === 0 &&
        type === 0 &&
        uint(count) &&
        count > 0
    )
}
function repairedCounts(tables, state) {
    ensure(
        policy.version === 1 &&
            policy.counting === 'distinct-repaired-world-collection' &&
            policy.location === 'configured-domain-scene',
        'Invalid world collection progress policy',
        ErrorCode.GameConfig,
    )
    const entries = state.home?.worldCollections ?? {},
        data = model(tables),
        counts = new Map([[0, 0]]),
        guids = new Set()
    ensure(record(entries), 'Malformed world collection repair state', ErrorCode.GameConfig)
    for (const [key, entry] of Object.entries(entries)) {
        const id = Number(key),
            world = data.worlds.get(id)
        ensure(
            uint(id) && id > 0 && String(id) === key && record(entry) && entry.collect_id === id && world,
            'Invalid world collection repair identity',
            ErrorCode.GameConfig,
        )
        // The client treats missing/zero build_id as not yet repaired. Merely
        // discovering a collection point or receiving its unbuilt data is not completion.
        if (entry.build_id === undefined || entry.build_id === 0) continue
        const building = data.buildings.get(entry.build_id)
        ensure(
            uint(entry.build_id) &&
                building &&
                building.groupId === world.groupId &&
                Number.isSafeInteger(building.level) &&
                building.level > 0 &&
                Number.isSafeInteger(entry.guid) &&
                entry.guid > 0 &&
                !guids.has(entry.guid),
            'Invalid repaired world collection building',
            ErrorCode.GameConfig,
        )
        guids.add(entry.guid)
        counts.set(0, counts.get(0) + 1)
        counts.set(world.sceneId, (counts.get(world.sceneId) ?? 0) + 1)
    }
    return counts
}
export function worldCollectionProgressValue(tables, state, tokens, facts = new Map()) {
    if (!worldCollectionProgressRule(tables, tokens)) return null
    const key = 'repaired-world-collections'
    if (!facts.has(key)) facts.set(key, repairedCounts(tables, state))
    return facts.get(key).get(tokens[1]) ?? 0
}
