import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/building-placement-progress-policy.json' with { type: 'json' }

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogues = new WeakMap()
ensure(
    policy.version === 1 &&
        policy.source === 'synced-owned-home-builds' &&
        policy.status === 'no-completion-filter-like-equivalent-client-readers' &&
        policy.history === 'observe-current-placed-state-with-monotonic-achievement-receipts' &&
        policy.officiallyVerified === false,
    'Invalid building placement progress policy',
    ErrorCode.GameConfig,
)

function catalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const groups = new Map(),
        builds = new Map(),
        types = new Set(),
        populatedGroups = new Set()
    for (const group of tables.get('home_building_group')) {
        ensure(
            uint(group.groupId) &&
                group.groupId > 0 &&
                uint(group.type) &&
                group.type > 0 &&
                !groups.has(group.groupId),
            'Malformed building placement group configuration',
            ErrorCode.GameConfig,
        )
        groups.set(group.groupId, group)
    }
    for (const row of tables.get('home_building')) {
        ensure(
            uint(row.id) && row.id > 0 && !builds.has(row.id) && groups.has(row.groupId),
            'Malformed building placement configuration',
            ErrorCode.GameConfig,
        )
        const group = groups.get(row.groupId)
        builds.set(row.id, { row, group })
        types.add(group.type)
        populatedGroups.add(group.groupId)
    }
    const result = { groups, builds, types, populatedGroups }
    catalogues.set(tables, result)
    return result
}

export function buildingPlacementRule(tables, tokens) {
    if (!Array.isArray(tokens) || !tokens.every(uint)) return false
    if (tokens[0] === 15020 && tokens.length === 4) {
        const [, type, group, count] = tokens,
            model = catalogue(tables)
        return (
            type > 0 &&
            count > 0 &&
            model.types.has(type) &&
            (group === 0 || (model.populatedGroups.has(group) && model.groups.get(group).type === type))
        )
    }
    if (tokens[0] === 13096 && tokens.length === 3) {
        const [, group, count] = tokens,
            model = catalogue(tables)
        return count > 0 && model.populatedGroups.has(group) && model.groups.get(group).type === 5
    }
    return false
}

function placedBuildings(tables, state) {
    const source = state.home?.builds ?? []
    ensure(Array.isArray(source), 'Malformed owned building list', ErrorCode.GameConfig)
    const model = catalogue(tables),
        seen = new Set(),
        rows = []
    for (const build of source) {
        ensure(
            object(build) && (build.build_type === undefined || uint(build.build_type)),
            'Malformed owned building instance',
            ErrorCode.GameConfig,
        )
        // SyncHomeBuild06018f08 omits these shell types and zero build IDs.
        if ([53, 55].includes(build.build_type) || build.build_id === undefined || build.build_id === 0) continue
        // Canonical server-owned source integrity, not extra native count
        // predicates: the allocator uses positive UInt32 IDs and unique rows.
        ensure(
            uint(build.guid) && build.guid > 0 && !seen.has(build.guid) && uint(build.build_id) && build.build_id > 0,
            'Invalid or duplicate owned building identity',
            ErrorCode.GameConfig,
        )
        seen.add(build.guid)
        const config = model.builds.get(build.build_id)
        ensure(config, 'Owned building configuration unavailable', ErrorCode.GameConfig)
        // Required object and quarter-turn range follow this server's
        // placeBuild/validatePlacement contract. The GUID readers do not test
        // these values; no claim is made about nullable client getter defaults.
        ensure(object(build.locate), 'Synced owned building has no placement', ErrorCode.GameConfig)
        for (const field of ['block_id', 'anchor'])
            ensure(
                build.locate[field] === undefined || uint(build.locate[field]),
                'Malformed owned building placement',
                ErrorCode.GameConfig,
            )
        ensure(
            build.locate.direction === undefined || (uint(build.locate.direction) && build.locate.direction <= 3),
            'Malformed owned building direction',
            ErrorCode.GameConfig,
        )
        ensure(
            build.status === undefined || uint(build.status),
            'Malformed owned building status',
            ErrorCode.GameConfig,
        )
        // Both positive client GUID readers classify the actual m_builds map
        // by configuration. They never test status1, build time or inventory.
        rows.push({ guid: build.guid, type: config.group.type, group: config.group.groupId })
    }
    return rows
}

export function buildingPlacementValue(tables, state, tokens, facts = new Map()) {
    if (!buildingPlacementRule(tables, tokens)) return null
    const key = 'building-placement:' + tokens.slice(0, -1).join(':')
    if (facts.has(key)) return facts.get(key)
    const rows = facts.get('building-placement:rows') ?? placedBuildings(tables, state)
    facts.set('building-placement:rows', rows)
    const count =
        tokens[0] === 15020
            ? rows.filter((row) => row.type === tokens[1] && (!tokens[2] || row.group === tokens[2])).length
            : rows.filter((row) => row.type === 5 && row.group === tokens[1]).length
    ensure(uint(count), 'Building placement count overflow', ErrorCode.GameConfig)
    facts.set(key, count)
    return count
}
