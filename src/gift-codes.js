import { createHash } from 'node:crypto'
import defaults from '../configs/gift-codes.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { mailGuid } from './mail-lifetime.js'
import { validateRewardDefinitions } from './rewards.js'

// Fresh CBT3 settingstore Lua + words/CHS. These are CDK business statuses,
// not ProtoErrorCode values and must only appear in the dedicated 6134 push.
export const GiftCodeStatus = Object.freeze({ Success: 0, Expired: 1, ConditionsNotMet: 2, AlreadyUsed: 3, Unknown: 4 })
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const hash = (text) => createHash('sha256').update(text).digest('hex')
const configError = (ok, message) => ensure(ok, message, ErrorCode.GameConfig)
const stableId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)
function text(value, maximum, message) {
    configError(typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0') && value.isWellFormed(), message)
    return value
}
function keys(object, allowed) {
    configError(object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every((key) => allowed.includes(key)), 'Malformed gift-code configuration')
}
function ledger(state) {
    const saved = state.giftCodeClaims === undefined ? { schema_version: 1, by_id: {} } : state.giftCodeClaims
    configError(saved && typeof saved === 'object' && !Array.isArray(saved) && saved.schema_version === 1 && saved.by_id && typeof saved.by_id === 'object' && !Array.isArray(saved.by_id), 'Saved gift-code claims are malformed')
    const identities = new Set()
    for (const [id, receipt] of Object.entries(saved.by_id)) {
        configError(stableId(id) && receipt && !Array.isArray(receipt) && receipt.id === id && typeof receipt.code_hash === 'string' && /^[a-f0-9]{64}$/.test(receipt.code_hash) && uint(receipt.created_at), 'Saved gift-code receipt is malformed')
        const guid = mailGuid(receipt.mail_guid, false, ErrorCode.GameConfig)
        configError(typeof receipt.mail_guid === 'string' && !identities.has(guid), 'Saved gift-code receipt identity is malformed or duplicated')
        identities.add(guid)
    }
    return saved.by_id
}
export class GiftCodeCatalog {
    constructor(source = defaults) {
        keys(source, ['schema_version', 'mode', 'codes'])
        configError(source.schema_version === 1 && source.mode === 'local-configured-mail' && Array.isArray(source.codes), 'Unsupported gift-code configuration')
        this.byCode = new Map()
        const ids = new Set()
        for (const input of source.codes) {
            keys(input, ['id', 'code', 'starts_at', 'ends_at', 'minimum_level', 'mail', 'rewards'])
            const row = structuredClone(input)
            configError(stableId(row.id), 'Invalid gift-code configuration identity')
            text(row.code, 20, 'Invalid configured gift code')
            configError(!ids.has(row.id) && !this.byCode.has(row.code), 'Duplicate gift-code identity or exact code')
            ids.add(row.id)
            row.starts_at ??= 0; row.ends_at ??= 0; row.minimum_level ??= 0
            configError(uint(row.starts_at) && uint(row.ends_at) && uint(row.minimum_level) && (!row.ends_at || row.ends_at > row.starts_at), 'Invalid gift-code window or eligibility configuration')
            keys(row.mail, ['sender', 'title', 'content', 'duration'])
            text(row.mail.sender, 256, 'Invalid gift-code mail sender')
            text(row.mail.title, 512, 'Invalid gift-code mail title')
            text(row.mail.content, 16384, 'Invalid gift-code mail content')
            configError(uint(row.mail.duration), 'Invalid gift-code mail duration')
            configError(Array.isArray(row.rewards) && row.rewards.length > 0 && row.rewards.length <= 100, 'Gift-code mail requires typed attachments')
            for (const reward of row.rewards) {
                keys(reward, ['itemtype', 'itemid', 'itemnum'])
                configError([reward.itemtype, reward.itemid, reward.itemnum].every((n) => uint(n) && n > 0), 'Invalid gift-code attachment quantity or identity')
            }
            row.code_hash = hash(row.code)
            this.byCode.set(row.code, row)
        }
    }
    redeem(c, request, store) {
        ensure(typeof request.code === 'string' && request.code.length > 0 && request.code.length <= 20 && request.code.isWellFormed(), 'Invalid gift code', ErrorCode.InvalidArgument)
        const notify = (status_code) => c.push('CSProtoExchangeGiftCodeNtf', { status_code })
        // LOCAL exact, case-sensitive matching. Never trim/normalize into a
        // second alias or contact the official redemption backend.
        const row = this.byCode.get(request.code)
        if (!row) { notify(GiftCodeStatus.Unknown); return {} }
        const claims = ledger(c.state)
        if (Object.hasOwn(claims, row.id)) { notify(GiftCodeStatus.AlreadyUsed); return {} }
        configError(uint(c.now), 'Gift-code server time is invalid')
        if (row.ends_at && c.now >= row.ends_at) { notify(GiftCodeStatus.Expired); return {} }
        configError(uint(c.state.player.basic_info.lv), 'Saved player level is malformed')
        if (c.now < row.starts_at || c.state.player.basic_info.lv < row.minimum_level) { notify(GiftCodeStatus.ConditionsNotMet); return {} }
        validateRewardDefinitions(c.tables, row.rewards)
        configError(Array.isArray(c.state.mail), 'Saved mail collection is malformed')
        const identities = new Set()
        for (const mail of c.state.mail) {
            const guid = mailGuid(mail?.guid, false, ErrorCode.MailConfigError)
            configError(!identities.has(guid), 'Duplicate saved mail identity')
            identities.add(guid)
        }
        configError(c.now + row.mail.duration <= 0xffffffff, 'Gift-code mail duration overflows')
        // LOCAL opaque mail-ID namespace. Allocation and both state mutations
        // share the existing durable Store transaction and codec rollback.
        const guid = String(0x8000000000000000n + BigInt(store.nextSequence('gift-code-mail')))
        configError(!identities.has(guid) && !Object.values(claims).some((receipt) => receipt.mail_guid === guid), 'Gift-code mail identity collision')
        const b64 = (value) => Buffer.from(value, 'utf8').toString('base64')
        const mail = { guid, createtm: c.now, effecttm: row.mail.duration, template_id: 0,
            sender_id: b64(row.mail.sender), title: b64(row.mail.title), content: b64(row.mail.content),
            reward: { rewards: structuredClone(row.rewards) }, fetch: false, read: false, collect: false, is_delete: false }
        c.state.mail.push(mail)
        if (c.state.giftCodeClaims === undefined) c.state.giftCodeClaims = { schema_version: 1, by_id: claims }
        claims[row.id] = { id: row.id, code_hash: row.code_hash, mail_guid: guid, created_at: c.now }
        c.pushBefore('CSProtoMailSync', { mails: [mail] })
        notify(GiftCodeStatus.Success)
        return {}
    }
}
export function registerGiftCodes(on, store, source) {
    const catalog = new GiftCodeCatalog(source)
    on('ExchangeGiftCode', (c, request) => catalog.redeem(c, request, store))
}
