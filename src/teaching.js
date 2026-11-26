import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { currentTeachingRoute } from './current-teaching-route.js'
const caches = new WeakMap()
export function teachingConfig(tables, dungeon) {
    ensure(dungeon, 'Teaching dungeon configuration unavailable', ErrorCode.DungeonConfNotExist)
    ensure(dungeon.dungeonType === 100, 'Teaching dungeon type mismatch', ErrorCode.InstanceTypeError)
    let cache = caches.get(tables)
    if (!cache) caches.set(tables, (cache = new Map()))
    if (cache.has(dungeon.id)) return cache.get(dungeon.id)
    const train = tables.get('train_task').find((row) => row.dungeonId === dungeon.id && [1, 2].includes(row.groupType))
    ensure(train, 'Unknown teaching task', ErrorCode.TrainTaskConfNone)
    const value = currentTeachingRoute(tables, dungeon, train)
    cache.set(dungeon.id, value)
    return value
}
