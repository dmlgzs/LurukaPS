import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/reading-achievement-policy.json' with { type: 'json' }

const caches = new WeakMap(),
    warned = new Set()
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
const positive = (v) => uint(v) && v > 0
function catalogue(tables) {
    if (caches.has(tables)) return caches.get(tables)
    ensure(
        policy.version === 1 &&
            policy.officiallyVerified === false &&
            policy.globalDomain === 'library_branch-series-subId-distinct-union' &&
            policy.specificBookDomain === 'configured-series-subId-membership' &&
            policy.readMarkerQualifiesOwnership === false &&
            policy.nonzeroAreaSelectorsSupported === false,
        'Invalid reading achievement policy',
        ErrorCode.GameConfig,
    )
    const books = new Set(),
        series = new Map(),
        global = new Set()
    for (const row of tables.get('library_readings')) {
        ensure(positive(row.id) && !books.has(row.id), 'Invalid reading catalogue identity', ErrorCode.GameConfig)
        books.add(row.id)
    }
    for (const row of tables.get('library_series')) {
        const ids = String(row.subId ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number)
        ensure(
            positive(row.id) &&
                !series.has(row.id) &&
                ids.length > 0 &&
                ids.every((id) => books.has(id)) &&
                new Set(ids).size === ids.length,
            'Invalid reading series membership',
            ErrorCode.GameConfig,
        )
        series.set(row.id, new Set(ids))
    }
    for (const row of tables.get('library_branch')) {
        const ids = String(row.seriesId ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number)
        ensure(
            positive(row.id) && ids.length > 0 && ids.every((id) => series.has(id)),
            'Invalid reading branch membership',
            ErrorCode.GameConfig,
        )
        for (const id of ids) for (const book of series.get(id)) global.add(book)
    }
    ensure(books.size > 0 && global.size > 0, 'Reading achievement catalogue is empty', ErrorCode.GameConfig)
    const result = { books, series, global }
    caches.set(tables, result)
    return result
}
export function readingAchievementRule(tables, tokens) {
    if (!Array.isArray(tokens) || ![13064, 15032].includes(tokens[0])) return false
    const data = catalogue(tables)
    if (tokens[0] === 13064) return tokens.length === 4 && tokens[1] === 0 && tokens[2] === 0 && positive(tokens[3])
    return (
        tokens.length === 3 &&
        positive(tokens[1]) &&
        positive(tokens[2]) &&
        data.series.get(tokens[1])?.has(tokens[2]) === true
    )
}
function owned(tables, state, facts) {
    if (facts.has('reading:owned')) return facts.get('reading:owned')
    const data = catalogue(tables),
        records = state.readingBooks
    ensure(
        records === undefined || (records && typeof records === 'object' && !Array.isArray(records)),
        'Invalid owned reading records',
        ErrorCode.GameConfig,
    )
    const result = new Set()
    for (const record of Object.values(records ?? {})) {
        ensure(
            record && typeof record === 'object' && !Array.isArray(record),
            'Invalid owned reading record',
            ErrorCode.GameConfig,
        )
        const raw = record.book_id === undefined || record.book_id === null ? 0 : record.book_id,
            id = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : raw
        ensure(uint(id), 'Invalid owned reading identity', ErrorCode.GameConfig)
        if (!data.books.has(id)) {
            if (!warned.has(id)) {
                warned.add(id)
                if (warned.size > 128) warned.delete(warned.values().next().value)
                console.warn('[reading-achievements] unknown-owned-book preserved and excluded: ' + id)
            }
            continue
        }
        //11025 resolves by book_id. Map keys and the separate unread marker
        //do not create extra ownership or require that the book be read first.
        result.add(id)
    }
    facts.set('reading:owned', result)
    return result
}
export function readingAchievementValue(tables, state, tokens, facts = new Map()) {
    if (!readingAchievementRule(tables, tokens)) return null
    const ids = owned(tables, state, facts)
    if (tokens[0] === 15032) return Number(ids.has(tokens[2]))
    if (facts.has('reading:global-count')) return facts.get('reading:global-count')
    let count = 0
    for (const id of catalogue(tables).global) if (ids.has(id)) count++
    facts.set('reading:global-count', count)
    return count
}
export function compileReadingConjunction(tables, ast, param) {
    if (ast?.type !== 'and') return null
    const leaves = []
    const collect = (node) => {
        if (node?.type === 'leaf') {
            leaves.push(node.tokens)
            return true
        }
        return node?.type === 'and' && collect(node.left) && collect(node.right)
    }
    if (
        !collect(ast) ||
        leaves.length < 2 ||
        leaves.length !== param ||
        leaves.length > 32 ||
        leaves.some(
            (tokens) => !Array.isArray(tokens) || tokens[0] !== 15032 || !readingAchievementRule(tables, tokens),
        ) ||
        new Set(leaves.map((tokens) => tokens[2])).size !== leaves.length
    )
        return null
    return { leaves }
}
export function readingConjunctionCounts(tables, state, rule, facts = new Map()) {
    const ids = owned(tables, state, facts)
    return rule.leaves.map((tokens) => Number(ids.has(tokens[2])))
}
