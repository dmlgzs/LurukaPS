import config from '../configs/mail-question-links.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

function guid(value, code) {
    if (typeof value === 'number') ensure(Number.isSafeInteger(value), 'Mail identity lost precision', code)
    const text = String(value ?? '')
    ensure(/^[1-9]\d*$/.test(text) && BigInt(text) <= 0xffffffffffffffffn, 'Invalid mail identity', code)
    return text
}
function u32(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
}

export function mailQuestionLink(c, request, source = config) {
    const selected = guid(request.u64, ErrorCode.InvalidMailID)
    ensure(Array.isArray(c.state.mail), 'Saved mail collection is malformed', ErrorCode.MailConfigError)
    const matches = c.state.mail.filter((mail) => {
        const value = mail?.guid
        if (typeof value === 'number' && !Number.isSafeInteger(value)) return false
        return String(value ?? '') === selected
    })
    ensure(matches.length > 0, 'Mail is not owned', ErrorCode.NoMail)
    ensure(matches.length === 1, 'Duplicate saved mail identity', ErrorCode.MailConfigError)
    const mail = matches[0],
        duration = mail.effecttm ?? 0,
        collect = mail.collect ?? false
    ensure(u32(duration) && typeof collect === 'boolean', 'Saved mail lifetime is malformed', ErrorCode.MailConfigError)
    ensure(!mail.is_delete, 'Mail was deleted', ErrorCode.NoMail)
    if (duration !== 0 && !collect) {
        ensure(
            u32(mail.createtm) && Number.isSafeInteger(c.now) && c.now >= 0,
            'Saved mail creation time is malformed',
            ErrorCode.MailConfigError,
        )
        const expires = mail.createtm + duration
        ensure(expires <= 0xffffffff, 'Saved mail lifetime overflows', ErrorCode.MailConfigError)
        ensure(expires > c.now, 'Mail has expired', ErrorCode.MailOverTime)
    }
    ensure(u32(mail.template_id) && mail.template_id > 0, 'Saved mail template is missing', ErrorCode.MailConfigError)
    ensure(
        source?.schema_version === 1 &&
            source.mode === 'public-template-link' &&
            Array.isArray(source.templates) &&
            Array.isArray(source.allowed_origins),
        'Mail link configuration is malformed',
        ErrorCode.MailConfigError,
    )
    const templates = source.templates.filter((row) => row?.id === mail.template_id)
    ensure(templates.length === 1, 'Mail template is missing or duplicated', ErrorCode.MailConfigError)
    const template = templates[0]
    ensure(Number.isInteger(template.jump_type), 'Mail jump type is malformed', ErrorCode.MailConfigError)
    ensure(template.jump_type === 3, 'Mail has no question link', ErrorCode.MailUrlNotFound)
    ensure(
        typeof template.link === 'string' && template.link.length > 0,
        'Mail question link is missing',
        ErrorCode.MailUrlNotFound,
    )
    let url
    try {
        url = new URL(template.link)
    } catch {
        ensure(false, 'Mail question URL is malformed', ErrorCode.MailConfigError)
    }
    ensure(
        url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.port &&
            !url.hash &&
            url.href === template.link &&
            source.allowed_origins.includes(url.origin),
        'Mail question URL is outside configured HTTPS origins',
        ErrorCode.MailConfigError,
    )
    // Local public-link policy: the client opens the returned string unchanged.
    // No questionnaireParam interpretation, per-user signing, completion or reward.
    return { link: template.link }
}
