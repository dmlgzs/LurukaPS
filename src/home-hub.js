import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const catalogs = new WeakMap()
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
function tabs(tables) {
    if (!catalogs.has(tables))
        catalogs.set(tables, new Map(tables.get('home_building_type').map((r) => [r.id, r.homeManageTab])))
    return catalogs.get(tables)
}
// The wire build_type is HomeHubTabType; each build_guid is the outer owned
// WorldMapHomeBuild identity, including fixed ranch and world-collection records.
export function homeHubPayload(tables, state, builds) {
    const orders = state.home.hubOrders ?? {}
    ensure(
        orders && typeof orders === 'object' && !Array.isArray(orders),
        'Invalid saved home-hub ordering',
        ErrorCode.GameConfig,
    )
    const groups = new Map([1, 2, 3, 4].map((type) => [type, []]))
    for (const b of builds) {
        const type = tabs(tables).get(b.build_type)
        if (!groups.has(type)) continue
        ensure(uint(b.guid) && b.guid > 0, 'Invalid home-hub building identity', ErrorCode.GameConfig)
        groups.get(type).push(b.guid)
    }
    const pos_infos = []
    for (const [type, guids] of groups) {
        ensure(new Set(guids).size === guids.length, 'Duplicate home-hub building identity', ErrorCode.GameConfig)
        const saved = orders[type] ?? []
        ensure(
            Array.isArray(saved) && saved.every((id) => uint(id) && id > 0) && new Set(saved).size === saved.length,
            'Invalid saved home-hub positions',
            ErrorCode.GameConfig,
        )
        const available = new Set(guids)
        const ordered = saved.filter((id) => available.has(id))
        const seen = new Set(ordered)
        ordered.push(...guids.filter((id) => !seen.has(id)).sort((a, b) => a - b))
        // Initial positions are local stable one-based indices, sent verbatim
        // back by the client. Removed buildings are absent; new ones append.
        pos_infos.push({ build_type: type, builds: ordered.map((build_guid, i) => ({ pos: i + 1, build_guid })) })
    }
    return { pos_infos, station_pets: state.home.stationPets ?? [] }
}
export function changeHomeHubPosition(state, request, hub) {
    ensure([1, 2, 3, 4].includes(request.type), 'Unknown home-hub tab', ErrorCode.HomeHubPosErr)
    const rows = hub.pos_infos.find((r) => r.build_type === request.type)?.builds ?? []
    const source = rows.findIndex((r) => r.pos === request.source_pos)
    const target = rows.findIndex((r) => r.pos === request.target_pos)
    ensure(source >= 0 && target >= 0, 'Home-hub position does not exist in this tab', ErrorCode.HomeHubPosErr)
    if (source === target) return false
    const order = rows.map((r) => r.build_guid)
    const [moved] = order.splice(source, 1)
    order.splice(target, 0, moved)
    ;(state.home.hubOrders ??= {})[request.type] = order
    state.homeRevision = (state.homeRevision ?? 0) + 1
    return true
}
