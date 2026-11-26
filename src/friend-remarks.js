import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const positive = (v) => Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const fullWidth = [
    [4352, 4447],
    [11904, 12350],
    [12353, 13311],
    [13312, 19903],
    [19968, 40959],
    [43360, 43391],
    [44032, 55203],
    [63744, 64255],
    [65072, 65103],
    [65281, 65376],
    [65504, 65510],
]
const models = new WeakMap()
function model(tables) {
    if (models.has(tables)) return models.get(tables)
    const row = tables.get('game').find((r) => r.title === 'PLAYER_NAME_MAX'),
        maximum = Number(row?.value)
    ensure(
        Number.isSafeInteger(maximum) && maximum > 0,
        'Friend remark length configuration is missing',
        ErrorCode.FriendCfgErr,
    )
    const ranges = tables
        .get('unicode_white')
        .filter((r) => r.isName === 1)
        .map((r) => {
            ensure(
                /^[0-9a-f]{4}$/i.test(r.unicode_start) && /^[0-9a-f]{4}$/i.test(r.unicode_end),
                'Friend remark Unicode configuration is malformed',
                ErrorCode.GameConfig,
            )
            const pair = [parseInt(r.unicode_start, 16), parseInt(r.unicode_end, 16)]
            ensure(pair[0] <= pair[1], 'Friend remark Unicode interval is malformed', ErrorCode.GameConfig)
            return pair
        })
    ensure(ranges.length > 0, 'Friend remark Unicode configuration is missing', ErrorCode.GameConfig)
    const result = { maximum, ranges }
    models.set(tables, result)
    return result
}
function ledger(state) {
    const rows = state.friendRemarks === undefined ? {} : state.friendRemarks
    ensure(object(rows), 'Saved friend remarks are malformed', ErrorCode.GameConfig)
    for (const [id, value] of Object.entries(rows)) {
        ensure(
            positive(Number(id)) &&
                String(Number(id)) === id &&
                typeof value === 'string' &&
                Buffer.from(value, 'base64').toString('base64') === value,
            'Saved friend remark identity or bytes are malformed',
            ErrorCode.GameConfig,
        )
        let text
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(value, 'base64'))
        } catch {
            ensure(false, 'Saved friend remark UTF8 is malformed', ErrorCode.GameConfig)
        }
        ensure(
            Buffer.from(text, 'utf8').toString('base64') === value,
            'Saved friend remark UTF8 is malformed',
            ErrorCode.GameConfig,
        )
    }
    return rows
}
export function validateFriendRemark(tables, value = '') {
    ensure(
        typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value,
        'Malformed friend remark bytes',
        ErrorCode.InvalidNick,
    )
    let text
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(value, 'base64'))
    } catch {
        ensure(false, 'Malformed friend remark UTF8', ErrorCode.InvalidNick)
    }
    const { maximum, ranges } = model(tables)
    let width = 0
    for (let i = 0; i < text.length; i++) {
        const cp = text.charCodeAt(i)
        ensure(
            ranges.some(([a, b]) => cp >= a && cp <= b),
            'Friend remark contains characters rejected by the current name input',
            ErrorCode.InvalidNick,
        )
        width += fullWidth.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1
    }
    ensure(width <= maximum, 'Friend remark is too long', ErrorCode.InvalidNick)
    return value
}
export function friendRemarkFields(state, id) {
    const rows = ledger(state)
    return Object.hasOwn(rows, id) ? { remark: rows[id] } : {}
}
export function saveFriendRemark(tables, state, id, value) {
    const rows = ledger(state),
        remark = validateFriendRemark(tables, value)
    state.friendRemarks = { ...rows, [id]: remark }
    return { id, remark }
}
export function forgetFriendRemark(state, id) {
    const rows = ledger(state)
    if (!Object.hasOwn(rows, id)) return
    const next = { ...rows }
    delete next[id]
    state.friendRemarks = next
}
