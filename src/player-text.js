import { TextDecoder } from 'node:util'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/player-text-policy.json' with { type: 'json' }
const cache = new WeakMap(),
    utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
// Current IsFullWidthChar060043ca; signature deliberately uses a different
// StringLength06004922 formula, not this table.
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
function directory(tables) {
    if (cache.has(tables)) return cache.get(tables)
    const buckets = new Map()
    for (const row of tables.get('unicode_white')) {
        ensure(
            Number.isInteger(row.isName) &&
                [0, 1].includes(row.isName) &&
                typeof row.unicode_start === 'string' &&
                /^[0-9a-fA-F]{4}$/.test(row.unicode_start) &&
                typeof row.unicode_end === 'string' &&
                /^[0-9a-fA-F]{4}$/.test(row.unicode_end),
            'Current player Unicode whitelist is malformed',
            ErrorCode.GameConfig,
        )
        const start = Number.parseInt(row.unicode_start, 16),
            end = Number.parseInt(row.unicode_end, 16)
        ensure(start <= end, 'Current player Unicode range is reversed', ErrorCode.GameConfig)
        if (!buckets.has(row.isName)) buckets.set(row.isName, [])
        buckets.get(row.isName).push([start, end])
    }
    ensure(
        buckets.get(0)?.length && buckets.get(1)?.length,
        'Current player Unicode whitelist is unavailable',
        ErrorCode.GameConfig,
    )
    const game = (title) => {
            const raw = tables.get('game').find((row) => row.title === title)?.value
            ensure(
                typeof raw === 'string' && /^\d+$/.test(raw),
                'Missing player text constant ' + title,
                ErrorCode.GameConfig,
            )
            const n = Number(raw)
            ensure(Number.isSafeInteger(n), 'Malformed player text constant ' + title, ErrorCode.GameConfig)
            return n
        },
        min = game('PLAYER_NAME_MIN'),
        max = game('PLAYER_NAME_MAX'),
        hours = game('PLAYER_CHANGE_NAME_CD')
    ensure(
        min > 0 && max >= min && max <= 0xffff && hours > 0 && hours * 3600 <= 0xffffffff,
        'Player text limits are malformed',
        ErrorCode.GameConfig,
    )
    const result = { buckets, min, max, cooldown: hours * 3600 }
    cache.set(tables, result)
    return result
}
function decode(value, { empty = false } = {}) {
    if (value === undefined && empty) value = ''
    ensure(
        typeof value === 'string' &&
            value.length % 4 === 0 &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
        'Player text bytes are malformed',
        ErrorCode.InvalidNick,
    )
    const bytes = Buffer.from(value, 'base64')
    ensure(bytes.toString('base64') === value, 'Player text bytes are not canonical', ErrorCode.InvalidNick)
    let text
    try {
        text = utf8.decode(bytes)
    } catch {
        ensure(false, 'Player text is not valid UTF8', ErrorCode.InvalidNick)
    }
    return { value, text }
}
function validatePolicy() {
    ensure(
        policy.version === 1 &&
            policy.localPolicy === true &&
            policy.officialSensitiveWordServiceRestored === false &&
            policy.globalNameUniqueness === 'not-inferred',
        'Player text policy is malformed',
        ErrorCode.GameConfig,
    )
    ensure(
        policy.mode === 'current-client-format-only',
        'Player text review is not implemented',
        ErrorCode.FunctionClosed,
    )
}
function validateCharacters(text, ranges) {
    for (let i = 0; i < text.length; i++)
        ensure(
            ranges.some(([a, b]) => text.charCodeAt(i) >= a && text.charCodeAt(i) <= b),
            'Player text contains an unavailable character',
            ErrorCode.InvalidNick,
        )
}
export function validatePlayerNameBytes(tables, value, { initial = false } = {}) {
    validatePolicy()
    const { text, value: encoded } = decode(value),
        rules = directory(tables)
    validateCharacters(text, rules.buckets.get(1))
    let width = 0,
        digits = 0
    for (let i = 0; i < text.length; i++) {
        const n = text.charCodeAt(i)
        width += fullWidth.some(([a, b]) => n >= a && n <= b) ? 2 : 1
        if (n >= 0x30 && n <= 0x39) digits++
        else if (/\p{Nd}/u.test(text[i])) digits += 2
    }
    ensure(width >= rules.min && width <= rules.max, 'Player name exceeds current input limits', ErrorCode.InvalidNick)
    if (initial) ensure(digits <= 6, 'Initial player name exceeds the current digit budget', ErrorCode.InvalidNick)
    return encoded
}
export function validatePlayerSignBytes(tables, value) {
    validatePolicy()
    const { text, value: encoded } = decode(value, { empty: true }),
        rules = directory(tables)
    validateCharacters(text, rules.buckets.get(0))
    let width = 0
    // Exact current LuaUtility regex: [4E00-9FA5 0800-4E00 AC00-D7FF].
    for (let i = 0; i < text.length; i++) {
        const n = text.charCodeAt(i)
        width += (n >= 0x800 && n <= 0x9fa5) || (n >= 0xac00 && n <= 0xd7ff) ? 2 : 1
    }
    ensure(width <= 40, 'Player signature exceeds the current input limit', ErrorCode.InvalidNick)
    return encoded
}
export function planPlayerRename(tables, state, request, now) {
    ensure(
        (request.cr ?? 0) === 0 && [0, 1].includes(request.check ?? 0),
        'Rename flag combination has no current sender contract',
        ErrorCode.FunctionClosed,
    )
    // Current PageCreatePlayer.OnClickBtnConfirm06015a16 sends check1 first.
    // Its success callback continues the creation timeline;5010 commits the
    // actual persona/name later. Preflight must not rename or start the CD.
    if (request.check === 1) {
        validatePlayerNameBytes(tables, request.name, { initial: true })
        return null
    }
    const name = validatePlayerNameBytes(tables, request.name),
        rules = directory(tables),
        last = state.player.basic_info.last_change_name_time ?? 0
    ensure(
        Number.isSafeInteger(now) &&
            now > 0 &&
            now <= 0xffffffff &&
            Number.isSafeInteger(last) &&
            last >= 0 &&
            last <= 0xffffffff,
        'Saved rename time is malformed',
        ErrorCode.GameConfig,
    )
    ensure(name !== state.player.basic_info.name, 'Player name has not changed', ErrorCode.InvalidNick)
    ensure(now >= last + rules.cooldown, 'Player rename is still cooling down', ErrorCode.ChangeNameTimeLimit)
    return { name, last_change_name_time: now }
}
