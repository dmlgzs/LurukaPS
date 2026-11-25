import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const homeBuildingResourceType = 13
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

// game.type declares both observed contracts: CBT3's one list and 1.0's
// list of five-value placements. Resource type 13 is HomeBuilding in both
// clients; it is not the building group/type carried by WorldMapHomeBuild.
export function defaultHomeBuildings(tables) {
    const row = tables.get('game').find((entry) => entry.title === 'HOME_DEFAULT_PLACEMENT')
    ensure(row && typeof row.value === 'string', 'Missing default home placement', ErrorCode.GameConfig)
    ensure(
        row.type === 'list<int>' || row.type === 'list<list<int>>',
        'Unsupported default home placement type',
        ErrorCode.GameConfig,
    )
    const nested = row.type === 'list<list<int>>',
        placements = nested ? row.value.split('|') : [row.value],
        builds = [],
        inventory = new Map()
    for (const placement of placements) {
        const tokens = placement.split(nested ? '#' : '|'),
            values = tokens.map(Number)
        ensure(
            tokens.length === 5 && tokens.every((value) => /^\d+$/.test(value)) && values.every(uint),
            'Invalid default home placement',
            ErrorCode.GameConfig,
        )
        const [resourceType, id, block, anchor, direction] = values
        ensure(
            resourceType === homeBuildingResourceType && id > 0 && block > 0 && direction <= 3,
            'Invalid default home placement values',
            ErrorCode.GameConfig,
        )
        const config = tables.find('home_building', id)
        ensure(config, 'Missing initial home building', ErrorCode.BuildConfNotFound)
        ensure(tables.find('home_block', block), 'Missing initial home block', ErrorCode.GameConfig)
        const group = tables.get('home_building_group').find((entry) => entry.groupId === config.groupId)
        ensure(group, 'Missing initial home building group', ErrorCode.BuildGroupConfNotFound)
        ensure(
            uint(group.type) && group.type > 0 && uint(config.level) && config.level > 0,
            'Invalid initial home building configuration',
            ErrorCode.GameConfig,
        )
        builds.push({
            guid: builds.length + 1,
            build_id: id,
            build_type: group.type,
            build_level: config.level,
            status: 1,
            locate: { block_id: block, anchor, direction },
        })
        const owned = inventory.get(id) ?? { build_id: id, total_num: 0, used_num: 0, unlock: true }
        owned.total_num += 1
        owned.used_num += 1
        inventory.set(id, owned)
    }
    return { inventory: [...inventory.values()], builds, nextBuildGuid: builds.length + 1 }
}
