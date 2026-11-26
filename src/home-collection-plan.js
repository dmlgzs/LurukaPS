import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
const catalogs = new WeakMap()

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff
function ids(value, label) {
    ensure(typeof value === 'string' && /^\d+(\|\d+)*$/.test(value), `Invalid ${label}`, ErrorCode.GameConfig)
    const result = value.split('|').map(Number)
    ensure(
        result.every(positive) && new Set(result).size === result.length,
        `Invalid ${label} identity`,
        ErrorCode.GameConfig,
    )
    return result
}
function index(rows, label) {
    ensure(
        Array.isArray(rows) &&
            rows.length > 0 &&
            rows.every((row) => positive(row.id)) &&
            new Set(rows.map((row) => row.id)).size === rows.length,
        `Invalid ${label} catalog`,
        ErrorCode.GameConfig,
    )
    return new Map(rows.map((row) => [row.id, row]))
}

// Current declared plans; station.products and historical table overrides are never consulted.
export function compileCollectionPlans(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const stations = index(tables.get('home_building_homecollection'), 'collection station')
    const plans = index(tables.get('home_building_collectionplan'), 'collection plan')
    const products = index(tables.get('products_collection'), 'collection product')
    const drops = index(tables.get('home_drop'), 'collection drop')
    const result = new Map()
    for (const station of stations.values()) {
        ensure(
            station.isNeedPet === 1 && positive(station.groupId) && positive(station.laborType),
            'Unsupported or invalid current collection labor contract',
            ErrorCode.GameConfig,
        )
        ids(station.petSize, 'collection pet size')
        const allowed = ids(station.planID, 'collection plan list').map((id) => {
            const plan = plans.get(id)
            ensure(
                plan && plan.groupId === station.groupId && plan.type === 1,
                'Collection plan does not belong to its station',
                ErrorCode.GameConfig,
            )
            const leaves = ids(plan.products, 'collection plan products').map((productId) => {
                const product = products.get(productId),
                    drop = product && drops.get(product.homeDropId)
                ensure(product, 'Declared collection product is missing', ErrorCode.CollectProductConfNotFound)
                ensure(drop, 'Declared collection drop is missing', ErrorCode.CollectDropConfNotFound)
                return { product, drop }
            })
            return { id, plan, leaves }
        })
        result.set(station.id, { station, allowed })
    }
    catalogs.set(tables, result)
    return result
}

export function resolveCollectionPlan(catalog, build) {
    const entry = catalog.get(build.build_id)
    ensure(entry, 'Collection station configuration is missing', ErrorCode.CollectBuildNotExist)
    const id = build.collect_build_data?.product_choose_id ?? 0
    ensure(Number.isSafeInteger(id) && id >= 0, 'Saved collection plan is malformed', ErrorCode.GameConfig)
    if (!id) {
        // A unique declared plan initializes legacy/unselected wire state. Multiple choices require selection.
        ensure(entry.allowed.length === 1, 'Collection plan selection is unresolved', ErrorCode.FunctionClosed)
        return { ...entry, selected: entry.allowed[0], needsInitialization: true }
    }
    const selected = entry.allowed.find((plan) => plan.id === id)
    ensure(selected, 'Saved collection plan is outside the station list', ErrorCode.GameConfig)
    return { ...entry, selected, needsInitialization: false }
}
