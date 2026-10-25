import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/entrust-star-progress-policy.json' with { type: 'json' }

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogues = new WeakMap()

function catalogue(tables) {
    if (!catalogues.has(tables)) {
        ensure(
            policy.version === 1 &&
                policy.condition === 12252 &&
                policy.starParameterIndex === 1 &&
                policy.countParameterIndex === 2 &&
                policy.scope === 'configured-dungeon-entrust-group-members' &&
                policy.recordField === 'entrust_star' &&
                policy.comparison === 'at-least' &&
                policy.officiallyVerified === false,
            'Invalid commission star progress policy',
            ErrorCode.GameConfig,
        )
        const groups = new Set()
        for (const row of tables.get('dungeon_entrust_group')) {
            ensure(
                uint(row.id) && row.id > 0 && !groups.has(row.id),
                'Invalid commission group catalogue',
                ErrorCode.GameConfig,
            )
            groups.add(row.id)
        }
        ensure(groups.size > 0, 'Missing commission group catalogue', ErrorCode.GameConfig)
        const rows = new Map()
        for (const row of tables.get('dungeon_entrust')) {
            ensure(
                uint(row.id) && row.id > 0 && !rows.has(row.id) && groups.has(row.groupId),
                'Invalid commission group member',
                ErrorCode.GameConfig,
            )
            rows.set(row.id, row)
        }
        ensure(rows.size > 0, 'Missing commission member catalogue', ErrorCode.GameConfig)
        catalogues.set(tables, rows)
    }
    return catalogues.get(tables)
}

export function entrustStarProgressRule(tables, tokens) {
    if (!Array.isArray(tokens) || tokens.length !== 3 || tokens[0] !== 12252) return false
    const [, star, count] = tokens
    if (!uint(star) || star < 1 || star > 3 || !uint(count) || count < 1) return false
    catalogue(tables)
    return true
}

export function entrustStarProgressValue(tables, state, tokens, facts = new Map()) {
    if (!entrustStarProgressRule(tables, tokens)) return null
    const [, star] = tokens
    const key = `commission-stars:${star}`
    if (facts.has(key)) return facts.get(key)
    const rows = catalogue(tables)
    const records = state.entrust?.records === undefined ? {} : state.entrust.records
    ensure(object(records), 'Malformed commission star history', ErrorCode.GameConfig)
    let count = 0
    for (const [key, record] of Object.entries(records)) {
        const id = Number(key)
        // Other/retired mode records are not members of the client's current
        // group enumeration. Never substitute inventory, run bits or clears.
        if (!rows.has(id)) continue
        ensure(String(id) === key && object(record), 'Invalid commission history identity', ErrorCode.GameConfig)
        ensure(
            record.entrust_id === undefined || record.entrust_id === id,
            'Commission history key does not match its identity',
            ErrorCode.GameConfig,
        )
        ensure(
            record.group_id === undefined || record.group_id === rows.get(id).groupId,
            'Commission history does not match its group',
            ErrorCode.GameConfig,
        )
        const value = record.entrust_star === undefined ? 0 : record.entrust_star
        ensure(uint(value) && value <= 3, 'Invalid saved commission star count', ErrorCode.GameConfig)
        if (value >= star) count++
    }
    facts.set(key, count)
    return count
}
