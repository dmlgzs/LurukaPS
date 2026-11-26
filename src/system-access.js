import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { SystemUnlocks } from './system-unlocks.js'
import { starterProfileMode } from './starter-profile.js'
const readers = new WeakMap()
const valid = (value, message) => ensure(value, message, ErrorCode.GameConfig)
// undefined means no prepared authority exists yet. It never means open.
// A caller may retain its existing, specific pre-bootstrap condition in that case.
export function preparedSystemAccess(tables, state, id) {
    valid(
        Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff && tables.find('system_unlock', id),
        'System access configuration is unavailable',
    )
    starterProfileMode(state)
    if (state.systemUnlockProgress === undefined) return undefined
    let reader = readers.get(tables)
    if (!reader) {
        reader = new SystemUnlocks(tables)
        readers.set(tables, reader)
    }
    const row = reader.inspect(state),
        locks = state.player?.basic_info?.lock_system
    valid(
        Array.isArray(locks) &&
            locks.every((value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff) &&
            new Set(locks).size === locks.length,
        'Prepared system lock projection is malformed',
    )
    valid(
        JSON.stringify([...locks].sort((a, b) => a - b)) === JSON.stringify(reader.locked(row)),
        'Prepared system lock projection differs from its permanent state',
    )
    return row.unlocked.includes(id)
}
