import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'
import { allocateHomeGuid } from './home-identities.js'
import { WorldObjectCatalog } from './world-objects.js'
import { parseRewards } from './rewards.js'
import { spend, spendCurrency } from './inventory.js'

const catalogs = new WeakMap()
function catalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const value = {
        worlds: new Map(tables.get('home_collection_world').map((row) => [row.id, row])),
        buildings: tables.get('home_building_collection'),
        domains: new Map(tables.get('domain').map((row) => [row.domainId, row])),
        areas: new Map(tables.get('area').map((row) => [row.areaId, row])),
        objects: new WorldObjectCatalog(tables),
    }
    catalogs.set(tables, value)
    return value
}
function condition(tables, text, state) {
    if (!text) return true
    const terms = String(text).includes('#')
        ? String(text)
              .split('|')
              .map((term) => term.split('#').map(Number))
        : [String(text).split('|').map(Number)]
    return terms.every(([kind, ...args]) => {
        ensure(
            args.length > 0 && args.every((n) => Number.isSafeInteger(n) && n > 0),
            'Invalid collection unlock condition',
            ErrorCode.GameConfig,
        )
        if (kind === 2007) {
            ensure(args.length === 1, 'Invalid completed-task collection condition', ErrorCode.GameConfig)
            return (state.taskRecords || []).some((row) => row.task_id === args[0] && row.count > 0)
        }
        ensure(
            [2004, 11009, 11012, 12045].includes(kind),
            'Collection unlock condition requires support',
            ErrorCode.FunctionClosed,
        )
        return homeCondition([kind, ...args].join('#'), state)
    })
}
export function worldCollectionConfiguration(tables, id) {
    const data = catalog(tables),
        world = data.worlds.get(id)
    ensure(world, 'Unknown world collection point', ErrorCode.CollectWorldConfNotFound)
    ensure(world.type === 1, 'Unsupported world collection type', ErrorCode.FunctionClosed)
    const rows = data.buildings.filter((row) => row.groupId === world.groupId && row.level === 1)
    ensure(rows.length === 1, 'Missing or ambiguous collection building level', ErrorCode.CollectBuildNextNone)
    const domain = data.domains.get(world.domainId)
    ensure(domain, 'Missing collection domain', ErrorCode.CollectDomainConfNotFound)
    ensure(
        Number.isSafeInteger(domain.sceneId) && domain.sceneId > 0,
        'Invalid collection domain scene',
        ErrorCode.GameConfig,
    )
    const area = data.areas.get(domain.areaId)
    ensure(area, 'Missing collection area configuration', ErrorCode.GameConfig)
    const raw = data.objects.find('worldmap_' + domain.sceneId, world.worldMapObjectUnfixed)
    ensure(
        raw && raw.cityId === domain.sceneId,
        'Collection world object is missing from its configured scene',
        ErrorCode.GameConfig,
    )
    const object = data.objects.object(domain.sceneId, world.worldMapObjectUnfixed)
    return { world, building: rows[0], domain, area, object }
}
export function worldCollectionPayload(entry) {
    return {
        guid: entry.guid,
        build_type: 55,
        collect_build_data: {
            guid: entry.collect_id,
            build_id: entry.build_id,
            product_infos: entry.product_infos ?? [],
            start_time: entry.start_time ?? 0,
            pet_guid: entry.pet_guid ?? '0',
            items: entry.items ?? [],
        },
    }
}
export function worldCollectionPayloads(state) {
    return Object.values(state.home?.worldCollections || {}).map(worldCollectionPayload)
}
export function unlockWorldCollection(c, request) {
    const { state, tables } = c
    ensure(state.home, 'Home state missing', ErrorCode.GameConfig)
    ensure(
        !(request.source_build ?? 0),
        'Collection source-building transfer requires support',
        ErrorCode.FunctionClosed,
    )
    const { world, building, domain, area } = worldCollectionConfiguration(tables, request.collect_id)
    const known = state.home.worldCollections?.[world.id]
    if (known) {
        ensure(
            known.collect_id === world.id &&
                known.build_id === building.id &&
                Number.isSafeInteger(known.guid) &&
                known.guid > 0,
            'Invalid saved world collection state',
            ErrorCode.GameConfig,
        )
        return known
    }
    ensure(
        condition(tables, domain.unlockCondition, state) &&
            condition(tables, area.unlockCondition, state) &&
            condition(tables, building.upgradeCondition, state),
        'Collection region or building prerequisite is incomplete',
        ErrorCode.CollectBuildConditionLimit,
    )
    const costs = parseRewards(building.material)
    ensure(
        costs.every((row) => row.itemtype === 3 || row.itemtype === 10),
        'Unsupported collection repair currency',
        ErrorCode.FunctionClosed,
    )
    const items = new Map()
    for (const row of costs) {
        if (row.itemtype === 3) items.set(row.itemid, (items.get(row.itemid) || 0) + row.itemnum)
        else spendCurrency(state, row.itemid, row.itemnum)
    }
    if (items.size) spend(state, items, 0, c.now)
    const entry = {
        guid: allocateHomeGuid(state.home),
        collect_id: world.id,
        build_id: building.id,
        product_infos: [],
        start_time: 0,
        pet_guid: '0',
        items: [],
    }
    ;(state.home.worldCollections ??= {})[world.id] = entry
    state.homeRevision = (state.homeRevision || 0) + 1
    // The current frontend refreshes the fixed collection from its type55
    // data/event14. Do not mark the root world object dead or grant its yields.
    // TODO: verify remote-page unlock, fixed model refresh and nonzero source
    // transfers with the actual client. No current sender supplies source_build.
    return entry
}
