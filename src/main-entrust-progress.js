import policy from '../configs/main-entrust-progress-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogues = new WeakMap()

function catalogue(tables) {
    if (!catalogues.has(tables)) {
        ensure(
            policy.version === 1 &&
                policy.condition === 12251 &&
                policy.scope === 'configured-dungeon-entrust-group-members' &&
                policy.unit === 'one-actual-victory' &&
                policy.repeatSameLevel === true &&
                policy.claimIndependent === true &&
                policy.oldPeriodBackfill === false &&
                policy.periodKey === 'main-entrust-clear' &&
                policy.officiallyVerified === false,
            'Invalid main commission clear policy',
            ErrorCode.GameConfig,
        )
        const groups = new Set()
        for (const row of tables.get('dungeon_entrust_group')) {
            ensure(
                uint(row.id) && row.id > 0 && !groups.has(row.id),
                'Invalid main commission group',
                ErrorCode.GameConfig,
            )
            groups.add(row.id)
        }
        const rows = new Map()
        for (const row of tables.get('dungeon_entrust')) {
            ensure(
                uint(row.id) &&
                    row.id > 0 &&
                    !rows.has(row.id) &&
                    groups.has(row.groupId) &&
                    uint(row.dungeonId) &&
                    row.dungeonId > 0 &&
                    tables.find('dungeon', row.dungeonId),
                'Invalid main commission member',
                ErrorCode.GameConfig,
            )
            rows.set(row.id, row)
        }
        ensure(rows.size > 0, 'Missing main commission members', ErrorCode.GameConfig)
        catalogues.set(tables, rows)
    }
    return catalogues.get(tables)
}

export function mainEntrustClearRule(tables, tokens) {
    if (!Array.isArray(tokens) || tokens.length !== 2 || tokens[0] !== 12251 || !uint(tokens[1]) || !tokens[1])
        return false
    catalogue(tables)
    return true
}

export function mainEntrustClearRevision(state) {
    const value = state.mainEntrustClearRevision === undefined ? 0 : state.mainEntrustClearRevision
    ensure(uint(value), 'Invalid main commission clear revision', ErrorCode.GameConfig)
    return value
}

export function mainEntrustClearKey(tables) {
    catalogue(tables)
    return policy.periodKey
}

export function mainEntrustClearPeriodValue(tables, counts, tokens) {
    if (!mainEntrustClearRule(tables, tokens)) return null
    ensure(object(counts), 'Invalid main commission period counts', ErrorCode.GameConfig)
    const key = mainEntrustClearKey(tables),
        value = counts[key] === undefined ? 0 : counts[key]
    ensure(uint(value), 'Invalid main commission period count', ErrorCode.GameConfig)
    // Old untyped12251 has no authenticated period producer and is ignored.
    return Math.min(tokens[1], value)
}

export function recordMainEntrustVictory(tables, state, run, route, now, fresh) {
    if (!fresh) return false
    const row = catalogue(tables).get(run?.entrust_id)
    ensure(
        row &&
            (run.kind === undefined || run.kind === 'entrust') &&
            route &&
            !route.material &&
            !route.weekly &&
            !route.repeat &&
            route.entrust.id === row.id &&
            route.entrust.groupId === row.groupId &&
            run.dungeon_id === row.dungeonId &&
            route.dungeon.id === row.dungeonId &&
            run.map_id === route.scene.id &&
            state.world.map_id === run.map_id &&
            uint(run.instance_id) &&
            run.instance_id > 0 &&
            run.battle_complete === true &&
            Number.isSafeInteger(now) &&
            now >= 0 &&
            run.end_time === now &&
            Number.isSafeInteger(run.battle_start_time) &&
            run.battle_start_time > 0 &&
            run.battle_start_time <= now,
        'Main commission clear source does not match its run',
        ErrorCode.GameConfig,
    )
    const revision = mainEntrustClearRevision(state)
    ensure(revision < 0xffffffff, 'Main commission clear revision overflow', ErrorCode.GameConfig)
    state.mainEntrustClearRevision = revision + 1
    return true
}
