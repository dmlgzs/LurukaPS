import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
function entries(value, code, label) {
    ensure(object(value), 'Invalid ' + label, code)
    const rows = value.entries === undefined ? [] : value.entries
    ensure(Array.isArray(rows), 'Invalid ' + label + ' entries', code)
    return rows.map((row) => {
        ensure(object(row), 'Invalid ' + label + ' entry', code)
        const key = row.key === undefined ? '' : row.key,
            val = row.val === undefined ? '' : row.val
        ensure(
            typeof key === 'string' &&
                typeof val === 'string' &&
                Buffer.from(key, 'utf8').toString('utf8') === key &&
                Buffer.from(val, 'utf8').toString('utf8') === val,
            'Invalid ' + label + ' string',
            code,
        )
        return { key, val }
    })
}
function identity(key) {
    // Current senders use Int32.ToString. Recognize the ordinary signed/zero-
    // padded integer forms too, matching SyncServerSettings' int dictionary;
    // unparseable/overflow opaque keys are retained, never applied as settings.
    const match = /^[\t\n\v\f\r ]*([+-]?\d+)[\t\n\v\f\r ]*$/.exec(key)
    if (match) {
        const n = BigInt(match[1])
        if (n >= -2147483648n && n <= 2147483647n) return 'int:' + n
    }
    return 'opaque:' + key
}
export function mergeClientSettings(saved, request) {
    const previous = saved === undefined ? [] : entries(saved, ErrorCode.GameConfig, 'saved client setting'),
        updates = entries(request, ErrorCode.InvalidArgument, 'client setting request')
    const merged = new Map()
    for (const row of [...previous, ...updates]) merged.set(identity(row.key), row)
    return { entries: [...merged.values()] }
}
export function registerClientSettings(on) {
    on('UpdateSetting', (c, request) => {
        // 11831 is a one-way delta. 11830 remains the existing complete-save
        // producer; PlayerData.settings is replayed by normal cold login.
        c.state.player.settings = mergeClientSettings(c.state.player.settings, request)
    })
}
