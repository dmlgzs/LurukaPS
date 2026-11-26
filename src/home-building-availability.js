import { createHash } from 'node:crypto'
import policy from '../configs/home-building-compatibility.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const valid = (condition, text) => ensure(condition, text, ErrorCode.GameConfig)

export function validateHomeBuildingCompatibilityPolicy(value) {
    valid(
        object(value) &&
            value.version === 1 &&
            value.policyId === 'retired-home-buildings-1.0.0-v1' &&
            value.local === true &&
            value.officiallyVerified === false &&
            value.oldAssetsUsable === false &&
            value.requiresColdClient === true &&
            value.scope === 'retired-inventory-and-building-shortcuts-only' &&
            value.unsupported === 'placed-or-stored-retired-instances',
        'Home-building compatibility policy is damaged',
    )
    valid(
        value.shortcutWriteback?.origin === 'LOCAL' &&
            value.shortcutWriteback.empty === 'retain-proven-retired-at-same-slot' &&
            value.shortcutWriteback.currentPositive === 'explicit-user-replacement' &&
            value.shortcutWriteback.archive === 'first-retired-identity-per-bar-and-slot',
        'Retired home-building shortcut writeback policy is damaged',
    )
    const rows = value.source?.identities
    valid(
        Array.isArray(rows) &&
            rows.length === 28 &&
            rows.every(
                (row) =>
                    object(row) &&
                    positive(row.id) &&
                    positive(row.groupId) &&
                    positive(row.objId) &&
                    row.type === 3 &&
                    typeof row.resourcePath === 'string',
            ) &&
            new Set(rows.map((row) => row.id)).size === rows.length,
        'Retired home-building identity policy is damaged',
    )
    valid(
        value.source.identitiesSha256 === digest([...rows].sort((a, b) => a.id - b.id)),
        'Retired home-building source identity fingerprint changed',
    )
    valid(
        value.target?.clientVersion === '1.0.0' &&
            value.target?.packageVersion === '3217420' &&
            /^[a-f0-9]{64}$/.test(value.target.buildingIdsSha256),
        'Retired home-building target identity policy is damaged',
    )
}
validateHomeBuildingCompatibilityPolicy(policy)
const retired = new Map(policy.source.identities.map((row) => [row.id, row]))
const catalogs = new WeakMap()
function index(rows, key, title) {
    valid(
        Array.isArray(rows) &&
            rows.length > 0 &&
            rows.every((row) => object(row) && positive(row[key])) &&
            new Set(rows.map((row) => row[key])).size === rows.length,
        `Current home-building ${title} directory is malformed`,
    )
    return new Map(rows.map((row) => [row[key], row]))
}
function catalog(tables) {
    let result = catalogs.get(tables)
    if (result) return result
    const buildings = index(tables.get('home_building'), 'id', 'identity')
    result = {
        buildings,
        objects: index(tables.get('home_object'), 'id', 'object'),
        groups: index(tables.get('home_building_group'), 'groupId', 'group'),
        idsSha256: digest([...buildings.keys()].sort((a, b) => a - b)),
    }
    catalogs.set(tables, result)
    return result
}

// Current catalog availability only. A prefab remaining in a resource pack is
// not permission to invent a new building ID or substitute the shared shrine.
export function homeBuildingAvailability(tables, id) {
    valid(positive(id), 'Home-building presentation identity is malformed')
    const data = catalog(tables),
        building = data.buildings.get(id)
    if (building) {
        valid(positive(building.objId), 'Referenced home-building object identity is malformed')
        const object = data.objects.get(building.objId)
        valid(object, 'Referenced home-building object configuration is missing')
        ensure(
            positive(building.groupId) && data.groups.has(building.groupId),
            'Referenced home-building group configuration is missing',
            ErrorCode.BuildGroupConfNotFound,
        )
        return { available: true, building, object, group: data.groups.get(building.groupId) }
    }
    const identity = retired.get(id)
    ensure(identity, 'Unknown missing home-building configuration', ErrorCode.BuildConfNotFound)
    // Only a real retired identity needs the complete verified target gate.
    // New valid definitions and unowned bad models cannot block ordinary bags.
    valid(
        data.idsSha256 === policy.target.buildingIdsSha256,
        'Retired home-building presentation requires the verified current identity catalog',
    )
    return { available: false, identity, reason: 'retired-current-catalog' }
}
