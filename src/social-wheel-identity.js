import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function socialActionIdentity(rows) {
    ensure(
        Array.isArray(rows) &&
            rows.every((row) => row && Number.isSafeInteger(row.id) && row.id > 0 && row.id <= 0xffffffff) &&
            new Set(rows.map((row) => row.id)).size === rows.length,
        'Invalid social action identities',
        ErrorCode.SocialEmotionsConfError,
    )
    const actions = rows.filter((row) => row.type === 2)
    ensure(
        actions.every((row) => typeof row.action === 'string' && !row.action.includes('\0')),
        'Invalid social action clip identity',
        ErrorCode.SocialEmotionsConfError,
    )
    return actions
        .filter((row) => row.action.length > 0)
        .map((row) => ({ id: row.id, type: 2, action: row.action }))
        .sort((a, b) => a.id - b.id)
}
export function socialActionFingerprint(rows) {
    return createHash('sha256')
        .update(JSON.stringify(socialActionIdentity(rows)))
        .digest('hex')
}
