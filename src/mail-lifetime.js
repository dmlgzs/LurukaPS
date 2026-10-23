import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
export function mailGuid(value, allowZero = false, code = ErrorCode.InvalidMailID) {
    if (typeof value === 'number') ensure(Number.isSafeInteger(value), 'Mail identity lost precision', code)
    const text = String(value ?? (allowZero ? '0' : ''))
    ensure(
        /^(0|[1-9]\d*)$/.test(text) && BigInt(text) <= 0xffffffffffffffffn && (allowZero || text !== '0'),
        'Invalid mail identity',
        code,
    )
    return text
}
export function mailEffectValid(mail, now) {
    const duration = mail.effecttm ?? 0,
        collect = mail.collect ?? false
    ensure(
        uint(duration) && typeof collect === 'boolean',
        'Saved mail lifetime is malformed',
        ErrorCode.MailConfigError,
    )
    // CBT3 MailStore.CheckMailEffectValid 06018117: permanent or collected
    // mail remains valid; finite life is a DURATION added to creation time.
    if (!duration || collect) return true
    ensure(uint(mail.createtm) && uint(now), 'Saved mail creation time is malformed', ErrorCode.MailConfigError)
    const end = mail.createtm + duration
    ensure(end <= 0xffffffff, 'Saved mail lifetime overflows', ErrorCode.MailConfigError)
    return end > now
}
export function selectMailRewards(state, request, now) {
    const requested = mailGuid(request.u64, true)
    ensure(Array.isArray(state.mail), 'Saved mail collection is malformed', ErrorCode.MailConfigError)
    const used = new Set(),
        rows = []
    for (const mail of state.mail) {
        ensure(mail && typeof mail === 'object', 'Saved mail is malformed', ErrorCode.MailConfigError)
        const id = mailGuid(mail.guid, false, ErrorCode.MailConfigError)
        ensure(!used.has(id), 'Duplicate saved mail identity', ErrorCode.MailConfigError)
        used.add(id)
        if (requested !== '0' && id !== requested) continue
        for (const field of ['fetch', 'is_delete'])
            ensure(
                mail[field] === undefined || typeof mail[field] === 'boolean',
                'Saved mail flag is malformed',
                ErrorCode.MailConfigError,
            )
        rows.push(mail)
    }
    if (requested !== '0') {
        ensure(rows.length && !rows[0].is_delete, 'Mail is not owned', ErrorCode.NoMail)
        ensure(!rows[0].fetch, 'Mail rewards have already been claimed', ErrorCode.AlreadyGetReward)
        ensure(mailEffectValid(rows[0], now), 'Mail has expired', ErrorCode.MailOverTime)
    }
    return rows.filter((mail) => !mail.is_delete && !mail.fetch && mailEffectValid(mail, now))
}
