import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
export function gridPosition(anchor) {
    ensure(Number.isInteger(anchor) && anchor >= 0 && anchor <= 0xffffffff, 'Invalid home anchor')
    const x = anchor >>> 16,
        y = anchor & 65535
    return { x: (x >>> 1) ^ -(x & 1), y: (y >>> 1) ^ -(y & 1) }
}
export function gridAnchor(x, y) {
    ensure(
        [x, y].every((n) => Number.isInteger(n) && n >= -32768 && n <= 32767),
        'Home coordinate outside signed 16-bit range',
    )
    return ((((x << 1) ^ (x >> 31)) << 16) | (((y << 1) ^ (y >> 31)) & 65535)) >>> 0
}
export function homeCondition(text, state) {
    if (!text) return true
    const terms = String(text).includes('#')
        ? String(text)
              .split('|')
              .map((s) => s.split('#').map(Number))
        : [String(text).split('|').map(Number)]
    return terms.every(([id, n, level]) => {
        if (id === 2004) return state.player.basic_info.lv >= n
        if (id === 12045)
            return (
                (state.tasks ?? []).some((task) => task.task_id === n && task.finish_nodes?.includes(level)) ||
                (state.taskRecords ?? []).some((record) => record.task_id === n && record.count > 0)
            )
        if (id === 11009) return (state.home?.stage || 1) >= n
        if (id === 11012) return (state.home?.technology?.levels[n]?.level || 0) >= (level || 1)
        if (id === 61001) return (state.reputations?.[n]?.level ?? 0) >= level
        return false
    })
}
export function buildingRect(tables, buildId, locate) {
    const config = tables.find('home_building', buildId),
        object = config && tables.find('home_object', config.objId)
    ensure(object, 'Missing building footprint', ErrorCode.BuildConfNotFound)
    let size = String(object.homeItemSize).split('|').map(Number)
    ensure(
        size.length === 2 && size.every((n) => Number.isInteger(n) && n > 0),
        'Invalid building footprint',
        ErrorCode.GameConfig,
    )
    const direction = locate?.direction ?? 0
    ensure(Number.isInteger(direction) && direction >= 0 && direction <= 3, 'Invalid home rotation')
    if (direction & 1) size.reverse()
    const pos = gridPosition(locate.anchor)
    return { x: pos.x, y: pos.y, w: size[0], h: size[1] }
}
export function validatePlacement(tables, state, buildId, locate, ignoreGuid = 0, { checkLimit = true } = {}) {
    ensure(locate, 'Missing building placement')
    for (const field of ['position', 'rotation', 'scale', 'center'])
        if (locate[field])
            ensure(
                ['x', 'y', 'z'].every(
                    (axis) => locate[field][axis] === undefined || Number.isFinite(locate[field][axis]),
                ),
                'Invalid building transform',
            )
    const block = tables.find('home_block', locate.block_id)
    ensure(block, 'Unknown home block')
    ensure(
        block.blockType === 0 && [1, 2].includes(block.groupType),
        'Not a building placement block',
        ErrorCode.InvalidProtoID,
    )
    ensure(homeCondition(block.unlockCondi, state), 'Home block is locked')
    const start = String(block.blockStartPos).split('|').map(Number),
        end = String(block.blockEndPos).split('|').map(Number)
    ensure(
        start.length === 2 && end.length === 2 && [...start, ...end].every(Number.isFinite),
        'Missing home block bounds',
        ErrorCode.GameConfig,
    )
    const rect = buildingRect(tables, buildId, locate)
    ensure(
        rect.x >= Math.min(start[0], end[0]) &&
            rect.y >= Math.min(start[1], end[1]) &&
            rect.x + rect.w <= Math.max(start[0], end[0]) &&
            rect.y + rect.h <= Math.max(start[1], end[1]),
        'Building lies outside home block',
    )
    for (const other of state.home.builds) {
        if (other.guid === ignoreGuid || other.locate.block_id !== locate.block_id) continue
        const r = buildingRect(tables, other.build_id, other.locate)
        ensure(
            !(rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y),
            'Building overlaps another building',
        )
    }
    const config = tables.find('home_building', buildId),
        group = tables.get('home_building_group').find((g) => g.groupId === config.groupId)
    ensure(group, 'Missing building group', ErrorCode.BuildGroupConfNotFound)
    ensure(homeCondition(group.unlockCondi, state), 'Building group is locked')
    // Existing owned fields can be upgraded into a type with no newly
    // constructible slots. Moving those instances does not allocate a slot.
    if (!checkLimit) return group
    const rows = tables
        .get('home_building_num')
        .filter((r) => r.groupId === group.groupId)
        .sort((a, b) => a.id - b.id)
    let limit = 0
    for (const row of rows) {
        if (!homeCondition(row.unlockCondition, state)) break
        ensure(Number.isInteger(row.addNum) && row.addNum >= 0, 'Invalid building limit', ErrorCode.GameConfig)
        limit += row.addNum
    }
    const used = state.home.builds.filter(
        (b) => b.guid !== ignoreGuid && tables.find('home_building', b.build_id)?.groupId === group.groupId,
    ).length
    ensure(used < limit, 'Building group limit reached')
    return group
}
