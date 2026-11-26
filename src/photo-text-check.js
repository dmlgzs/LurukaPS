import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/photo-text-check-policy.json' with { type: 'json' }

const directories = new WeakMap()
// Current IsFullWidthChar060043ca. The photo dialog's 7 is multiplied by2
// in pageCommonTextBox; the actual bound is14 half-width UTF16 units.
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
function whiteRanges(tables) {
    if (directories.has(tables)) return directories.get(tables)
    const rows = tables.get('unicode_white').filter((row) => row.isName === 0),
        ids = new Set()
    ensure(rows.length > 0, 'Current photo Unicode whitelist is unavailable', ErrorCode.GameConfig)
    const ranges = rows.map((row) => {
        ensure(
            Number.isSafeInteger(row.Id) &&
                row.Id > 0 &&
                !ids.has(row.Id) &&
                typeof row.unicode_start === 'string' &&
                /^[0-9a-fA-F]{4}$/.test(row.unicode_start) &&
                typeof row.unicode_end === 'string' &&
                /^[0-9a-fA-F]{4}$/.test(row.unicode_end),
            'Current photo Unicode whitelist is malformed',
            ErrorCode.GameConfig,
        )
        ids.add(row.Id)
        const start = Number.parseInt(row.unicode_start, 16),
            end = Number.parseInt(row.unicode_end, 16)
        ensure(start <= end, 'Current photo Unicode range is reversed', ErrorCode.GameConfig)
        return [start, end]
    })
    directories.set(tables, ranges)
    return ranges
}
export function checkPhotoText(tables, request) {
    ensure(
        policy.version === 1 && policy.localPolicy === true && policy.officialSensitiveWordServiceRestored === false,
        'Photo text review policy is malformed',
        ErrorCode.GameConfig,
    )
    ensure(
        policy.mode === 'current-photo-format-only',
        'Photo text review policy is not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(
        request && typeof request === 'object' && !Array.isArray(request),
        'Photo text request is malformed',
        ErrorCode.InvalidArgument,
    )
    const text = request.data_info ?? ''
    ensure(
        typeof text === 'string' && text.isWellFormed(),
        'Photo text must be a well-formed string',
        ErrorCode.InvalidArgument,
    )
    const ranges = whiteRanges(tables)
    let units = 0
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        // The Lua source uses a byte range80..FF, not a Chinese-only range.
        ensure(
            code > 0x7f && ranges.some(([a, b]) => code >= a && code <= b),
            'Photo text contains a character unavailable to the current input field',
            ErrorCode.InvalidArgument,
        )
        units += fullWidth.some(([a, b]) => code >= a && code <= b) ? 2 : 1
        ensure(units <= 14, 'Photo text exceeds the current dialog limit', ErrorCode.InvalidArgument)
    }
    // No official sensitive-word service or invented vocabulary is consulted.
    // The current callback ignores rsp text and displays its original input.
    return { data_info: text }
}
export function registerPhotoTextCheck(on) {
    on('GeneralDirtyCheck', (c, r) => checkPhotoText(c.tables, r))
}
