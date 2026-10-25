import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/material-clear-progress-policy.json' with { type: 'json' }
const catalogues = new WeakMap()
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
export function materialClearCatalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    ensure(
        policy.version === 1 &&
            policy.officiallyVerified === false &&
            policy.unit === 'one-actual-victory' &&
            policy.claimIndependent === true &&
            policy.difficulty === 'minimum' &&
            policy.oldPeriodBackfill === false,
        'Invalid material clear policy',
        ErrorCode.GameConfig,
    )
    const tags = new Set(tables.get('dungeon_material_tag').map((r) => r.id)),
        types = new Map(tables.get('dungeon_material_type').map((r) => [r.id, r.tagId])),
        diffs = new Set(tables.get('dungeon_material_diff').map((r) => r.diff)),
        rows = new Map(),
        tuples = new Set()
    for (const row of tables.get('dungeon_material')) {
        ensure(
            positive(row.id) &&
                !rows.has(row.id) &&
                positive(row.dungeonId) &&
                positive(row.diff) &&
                positive(row.type) &&
                positive(types.get(row.type)) &&
                diffs.has(row.diff) &&
                types.has(row.type) &&
                tags.has(types.get(row.type)),
            'Invalid material clear classification',
            ErrorCode.GameConfig,
        )
        const value = { id: row.id, dungeonId: row.dungeonId, diff: row.diff, type: row.type, tag: types.get(row.type) }
        rows.set(row.id, value)
        tuples.add([value.diff, value.tag, value.type].join(':'))
    }
    ensure(rows.size > 0, 'Material clear catalogue is empty', ErrorCode.GameConfig)
    const result = { tags, types, diffs, rows, tuples }
    catalogues.set(tables, result)
    return result
}
export function materialClearRule(tables, tokens) {
    if (!Array.isArray(tokens) || tokens.length !== 6 || tokens[0] !== 15010 || !tokens.every(uint)) return false
    const [, diff, tag, type, extra, target] = tokens,
        c = materialClearCatalogue(tables)
    return (
        (diff === 0 || c.diffs.has(diff)) &&
        c.tags.has(tag) &&
        (type === 0 || c.types.get(type) === tag) &&
        extra === 0 &&
        positive(target)
    )
}
export function materialClearMatches(tokens, tuple) {
    return (
        (tokens[1] === 0 || tuple.diff >= tokens[1]) &&
        tokens[2] === tuple.tag &&
        (tokens[3] === 0 || tokens[3] === tuple.type)
    )
}
export function materialClearRevision(state) {
    const n = state.materialClearRevision === undefined ? 0 : state.materialClearRevision
    ensure(uint(n), 'Invalid material clear revision', ErrorCode.GameConfig)
    return n
}
export function materialClearFacts(tables, state, facts = new Map()) {
    if (facts.has('material-clears')) return facts.get('material-clears')
    const c = materialClearCatalogue(tables),
        records = state.materialDungeonRecords
    ensure(
        records === undefined || (records && typeof records === 'object' && !Array.isArray(records)),
        'Invalid material clear history',
        ErrorCode.GameConfig,
    )
    const result = []
    for (const [key, record] of Object.entries(records ?? {})) {
        const id = Number(key),
            tuple = c.rows.get(id)
        ensure(
            positive(id) &&
                String(id) === key &&
                tuple &&
                record &&
                record.material_id === id &&
                record.difficulty_id === tuple.diff &&
                uint(record.success_count),
            'Invalid saved material clear identity or count',
            ErrorCode.GameConfig,
        )
        result.push({ ...tuple, count: record.success_count })
    }
    facts.set('material-clears', result)
    return result
}
export function materialClearValue(tables, state, tokens, facts = new Map()) {
    if (!materialClearRule(tables, tokens)) return null
    let count = 0
    for (const row of materialClearFacts(tables, state, facts))
        if (materialClearMatches(tokens, row)) {
            count += row.count
            ensure(
                Number.isSafeInteger(count) && count <= 0xffffffff,
                'Material clear total overflow',
                ErrorCode.GameConfig,
            )
        }
    return Math.min(tokens[5], count)
}
export function materialClearKey(tables, tuple) {
    const c = materialClearCatalogue(tables),
        key = [tuple.diff, tuple.tag, tuple.type].join(':')
    ensure(c.tuples.has(key), 'Invalid typed material clear source', ErrorCode.GameConfig)
    return 'material-clear:' + key
}
export function materialClearTupleFromKey(tables, key) {
    if (!key.startsWith('material-clear:')) return null
    const raw = key.slice('material-clear:'.length),
        parts = raw.split(':').map(Number),
        c = materialClearCatalogue(tables)
    ensure(
        parts.length === 3 && parts.every(positive) && parts.join(':') === raw && c.tuples.has(raw),
        'Invalid saved typed material clear key',
        ErrorCode.GameConfig,
    )
    return { diff: parts[0], tag: parts[1], type: parts[2] }
}
export function materialClearPeriodValue(tables, counts, tokens) {
    if (!materialClearRule(tables, tokens)) return 0
    let total = 0
    for (const [key, count] of Object.entries(counts)) {
        const tuple = materialClearTupleFromKey(tables, key)
        if (!tuple) continue
        ensure(uint(count), 'Invalid typed material clear period count', ErrorCode.GameConfig)
        if (materialClearMatches(tokens, tuple)) total += count
        ensure(
            Number.isSafeInteger(total) && total <= 0xffffffff,
            'Typed material clear period total overflow',
            ErrorCode.GameConfig,
        )
    }
    return Math.min(tokens[5], total)
}
