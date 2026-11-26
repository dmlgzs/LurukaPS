import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function worldPointRewardDefinition(tables, id) {
    const point = tables.find('world_borthpos', id)
    ensure(point, 'Reward birth point configuration is unavailable', ErrorCode.NotFoundBirthPoint)
    ensure(tables.find('world_city', point.cityId), 'Reward birth point city is unavailable', ErrorCode.NoWorldCityConf)
    return point
}

export function grantWorldPoint(tables, state, id) {
    worldPointRewardDefinition(tables, id)
    const points = state.world?.points ?? []
    ensure(
        state.world &&
            Array.isArray(points) &&
            points.every((value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff),
        'Invalid unlocked world point state',
        ErrorCode.GameConfig,
    )
    if (points.includes(id)) return false
    state.world.points = [...new Set([...points, id])].sort((a, b) => a - b)
    state.worldPointRewardRevision = (state.worldPointRewardRevision ?? 0) + 1
    return true
}
