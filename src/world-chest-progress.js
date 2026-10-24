import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { WorldObjectCatalog } from './world-objects.js'
import { recordActiveProgress } from './daily-active.js'
import policy from '../configs/world-chest-progress-policy.json' with { type: 'json' }

// CBT3 EWorldObjectType: PuzzleChestItem, Chest, Wooden/Silver/Iron/Gold.
// Never classify generic Item(3), harvesting, or a chest-looking resource.
const catalogs = new WeakMap()
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
ensure(
    policy.version === 1 &&
        policy.creditOn === 'first-full-claim' &&
        policy.historical === 'confirmed-static-receipts-only' &&
        policy.officially_verified === false &&
        [policy.fieldMapTypes, policy.chestObjectTypes].every(
            (values) =>
                Array.isArray(values) &&
                values.every((value) => uint(value) && value > 0) &&
                new Set(values).size === values.length,
        ),
    'World chest progress policy unavailable',
    ErrorCode.GameConfig,
)
const chestTypes = new Set(policy.chestObjectTypes),
    fieldTypes = new Set(policy.fieldMapTypes)

export function isFieldChest(tables, map, spawner) {
    // Current deployed field-map family. TDWorldCity.isBigWorld is zero in
    // these tables and cannot be treated as a boolean feature gate.
    return fieldTypes.has(tables.find('world_city', map)?.type) && chestTypes.has(spawner?.objectType)
}

function catalog(tables) {
    if (!catalogs.has(tables)) catalogs.set(tables, new WorldObjectCatalog(tables))
    return catalogs.get(tables)
}

function history(tables, state, objects = catalog(tables)) {
    let ledger = state.worldChestHistory
    if (ledger === undefined) {
        let total = 0
        for (const [key, saved] of Object.entries(state.worldObjects ?? {})) {
            if (saved?.complete !== true || saved.claims?.complete !== true) continue
            const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(key)
            if (!match) continue
            const map = Number(match[1]),
                id = Number(match[2])
            if (!uint(map) || !uint(id) || saved.obj_id !== id || !fieldTypes.has(tables.find('world_city', map)?.type))
                continue
            let row
            try {
                row = objects.find('worldmap_' + map, id)
            } catch (error) {
                if (error.code === 'ENOENT') continue
                throw error
            }
            if (row?.cityId !== map || row.initialCompleteState) continue
            const spawner = objects.find('world_spawner', row.spawnerId)
            if (isFieldChest(tables, map, spawner)) total++
        }
        // Only confirmed, still classifiable static claim receipts migrate.
        // This lifetime lower bound never supplies daily/weekly past events.
        state.worldChestHistory = ledger = { version: 1, total }
    }
    ensure(
        ledger && typeof ledger === 'object' && !Array.isArray(ledger) && ledger.version === 1 && uint(ledger.total),
        'Invalid world chest history',
        ErrorCode.GameConfig,
    )
    return ledger
}

export function worldChestsOpened(tables, state) {
    return history(tables, state).total
}

export function recordWorldChestOpen(c, objects, row, spawner, before, current) {
    if (
        !isFieldChest(c.tables, c.state.world.map_id, spawner) ||
        row.initialCompleteState ||
        before.complete ||
        before.claimed ||
        current.complete !== true ||
        current.claims?.complete !== true
    )
        return false
    // Called only AFTER this object's validated claim is stored. A first
    // migration therefore already includes the new receipt; don't add twice.
    const initialized = c.state.worldChestHistory !== undefined,
        previous = history(c.tables, c.state, objects)
    if (initialized) {
        ensure(previous.total < 0xffffffff, 'World chest count overflow', ErrorCode.GameConfig)
        c.state.worldChestHistory = { ...previous, total: previous.total + 1 }
    }
    recordActiveProgress(c.tables, c.state, 12072, 1, c.now)
    return true
}
