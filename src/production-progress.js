import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { productionTables } from './production-tables.js'
import { parseRewards } from './rewards.js'
import policy from '../configs/production-progress-policy.json' with { type: 'json' }

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogues = new WeakMap()
ensure(
    policy.version === 1 &&
        policy.creditOn === 'successful-output-claim' &&
        policy.historical === 'do-not-reinterpret-untyped-counts' &&
        policy.officially_verified === false,
    'Invalid production progress policy',
    ErrorCode.GameConfig,
)

function catalogue(external) {
    const tables = productionTables(external)
    if (catalogues.has(tables)) return catalogues.get(tables)
    const buildingGroups = new Map(tables.get('home_building_group').map((row) => [row.groupId, row.type]))
    const buildings = new Map(tables.get('home_building').map((row) => [row.id, buildingGroups.get(row.groupId)]))
    const stationTypes = new Map()
    for (const station of tables.get('home_building_production')) {
        const type = buildings.get(station.id)
        if (![2, 8, 10].includes(type)) continue
        if (!stationTypes.has(station.groupId)) stationTypes.set(station.groupId, new Set())
        stationTypes.get(station.groupId).add(type)
    }
    const keys = new Set()
    const add = (groups, rewards) => {
        for (const group of String(groups).split('|').map(Number))
            for (const type of stationTypes.get(group) ?? [])
                for (const reward of rewards) {
                    keys.add(`${type}:${reward.itemtype}:${reward.itemid}`)
                    // Only the three current wildcard selector domains are established.
                    if (['2:10', '2:25', '8:33'].includes(`${type}:${reward.itemtype}`))
                        keys.add(`${type}:${reward.itemtype}:0`)
                }
    }
    for (const row of tables.get('products'))
        if (!row.notReleased && !row.isNeedPet) add(row.group, parseRewards(row.rewardId))
    // Current accessory jobs preserve a preselected type33 output. Do not use
    // obsolete products/group13 or pretend a wildcard identifies a specific leaf.
    for (const row of tables.get('accessory_product')) add(row.group, [{ itemtype: 33, itemid: 0 }])
    const result = { keys, buildings }
    catalogues.set(tables, result)
    return result
}

export function productionProgressRule(tables, tokens) {
    if (!Array.isArray(tokens) || tokens.length !== 5 || tokens[0] !== 12018 || !tokens.every(uint)) return false
    const [, type, resource, id, target] = tokens
    return type > 0 && resource > 0 && target > 0 && catalogue(tables).keys.has(`${type}:${resource}:${id}`)
}

function history(state) {
    const ledger = state.home?.productionProgress
    if (ledger === undefined) return { version: 1, counts: {} }
    ensure(
        object(ledger) && ledger.version === 1 && object(ledger.counts),
        'Malformed production progress history',
        ErrorCode.GameConfig,
    )
    for (const [key, count] of Object.entries(ledger.counts)) {
        const values = key.split(':').map(Number)
        ensure(
            values.length === 3 &&
                values.every((value) => uint(value) && value > 0) &&
                values.join(':') === key &&
                uint(count),
            'Malformed production progress counter',
            ErrorCode.GameConfig,
        )
    }
    return ledger
}

// Called only after grantRewards succeeds, in the existing claim transaction.
// Refunds, hatch receipts, inventory/GM grants and portable crafting never call it.
export function recordProductionOutput(tables, state, build, rewards) {
    const type = catalogue(tables).buildings.get(build.build_id)
    ensure(
        uint(type) && type > 0 && build.build_type === type,
        'Production building type does not match configuration',
        ErrorCode.GameConfig,
    )
    const previous = history(state),
        counts = { ...previous.counts }
    for (const row of rewards) {
        ensure(
            [row.itemtype, row.itemid, row.itemnum].every((value) => uint(value) && value > 0),
            'Invalid production progress output',
            ErrorCode.GameConfig,
        )
        const key = `${type}:${row.itemtype}:${row.itemid}`,
            next = (counts[key] ?? 0) + row.itemnum
        ensure(uint(next), 'Production progress overflow', ErrorCode.GameConfig)
        counts[key] = next
    }
    state.home.productionProgress = { version: 1, counts }
}

export function productionProgressValue(tables, state, tokens, facts = new Map()) {
    if (!productionProgressRule(tables, tokens)) return null
    const [, type, resource, id] = tokens,
        key = `production:${type}:${resource}:${id}`
    if (facts.has(key)) return facts.get(key)
    const ledger = facts.get('production:history') ?? history(state)
    facts.set('production:history', ledger)
    let count = 0
    for (const [selector, value] of Object.entries(ledger.counts)) {
        const [building, itemtype, itemid] = selector.split(':').map(Number)
        if (building === type && itemtype === resource && (id === 0 || itemid === id)) count += value
    }
    ensure(Number.isSafeInteger(count) && count >= 0, 'Production progress total overflow', ErrorCode.GameConfig)
    facts.set(key, count)
    return count
}
