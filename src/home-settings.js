import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

function entries(value, code, label) {
    ensure(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`, code)
    const list = value.entries === undefined ? [] : value.entries
    ensure(Array.isArray(list), `Invalid ${label} entries`, code)
    return list.map((entry) => {
        ensure(entry && typeof entry === 'object' && !Array.isArray(entry), `Invalid ${label} entry`, code)
        // CBT3 proto2 optional strings default to empty; empty is a value, not deletion.
        const key = entry.key === undefined ? '' : entry.key
        const val = entry.val === undefined ? '' : entry.val
        ensure(typeof key === 'string' && typeof val === 'string', `Invalid ${label} entry`, code)
        return [key, val]
    })
}

export function mergeHomeSettings(saved, request) {
    // Validate both complete inputs before publishing any update. Only an absent
    // legacy field initializes storage; null or malformed saved data is corruption.
    const previous = saved === undefined ? [] : entries(saved, ErrorCode.GameConfig, 'saved home setting')
    const updates = entries(request, ErrorCode.InvalidArgument, 'home setting request')
    // SyncServerHomeSettings uses Dictionary.set_Item: duplicate keys are last-wins.
    const merged = new Map(previous)
    for (const [key, val] of updates) merged.set(key, val)
    return { entries: [...merged].map(([key, val]) => ({ key, val })) }
}
