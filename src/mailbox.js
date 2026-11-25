import { randomUUID, randomBytes } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { mailGuid, mailEffectValid } from './mail-lifetime.js'
import { grantRewards } from './rewards.js'

// Mail.proto/ProtoEnum.lua operation payload enums, not global protocol errors.
export const MailOperationCode = Object.freeze({
    Ok: 0,
    InvalidArgument: 2,
    InvalidCursor: 3,
    NotFound: 4,
    Protected: 5,
    Conflict: 6,
    UnknownEnum: 8,
    FavoriteLimit: 9,
    ClaimCapacityFull: 10,
    ClaimPartialCapacityFull: 11,
    ClaimPartialFailed: 14,
    NoClaimableReward: 15,
})
const ClaimStatus = Object.freeze({ Succeeded: 3, Failed: 4 })
const ClaimAllState = Object.freeze({ Running: 1, Finished: 2 })
const ListType = Object.freeze({ All: 1, Unread: 2, Favorite: 3 })
const ChangeType = Object.freeze({ Upsert: 1, Delete: 2 })
const Select = Object.freeze({ MailIds: 1, AllRead: 2 })
const capacityErrors = new Set([
    ErrorCode.MailPetFull,
    ErrorCode.BagPetFullForAdd,
    ErrorCode.PetEggBagFull,
    ErrorCode.BagItemFull,
    ErrorCode.SoulEssenceBagFull,
    ErrorCode.OrnamentBagFull,
])
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const config = (value, message) => ensure(value, message, ErrorCode.MailConfigError)
const copy = (value) => structuredClone(value)
function bytes(value, empty = true) {
    if (value === undefined && empty) return ''
    config(
        typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value,
        'Malformed saved mail bytes',
    )
    return value
}
function token(value) {
    return typeof value === 'string' && value.length > 0 && Buffer.from(value, 'base64').toString('base64') === value
}
function limits(tables) {
    const rows = tables.get('game'),
        get = (name) => Number(rows.find((row) => row.title === name)?.value)
    const capacity = get('MAIL_LIMITS'),
        favorites = get('MAIL_COLLECTION_NUM')
    config(
        Number.isSafeInteger(capacity) && capacity > 0 && Number.isSafeInteger(favorites) && favorites > 0,
        'Missing mailbox limits',
    )
    return { capacity, favorites }
}
function rewards(mail) {
    config(
        mail.reward === undefined || (mail.reward && Array.isArray(mail.reward.rewards)),
        'Malformed mail attachment collection',
    )
    return (mail.reward?.rewards ?? []).map((row) => ({ ...row, itemtype: row.itemtype ?? 3 }))
}
function view(mail, now) {
    config(mail && typeof mail === 'object' && !Array.isArray(mail), 'Malformed saved mail')
    const mail_id = mailGuid(mail.guid, false, ErrorCode.MailConfigError)
    config(uint(mail.createtm), 'Malformed saved mail creation time')
    for (const name of ['read', 'fetch', 'collect', 'is_delete'])
        config(mail[name] === undefined || typeof mail[name] === 'boolean', 'Malformed saved mail flag')
    const visible = mail.visible_time ?? mail.createtm
    config(uint(visible), 'Malformed mail visibility time')
    const valid = mailEffectValid(mail, now)
    const expire = (mail.effecttm ?? 0) ? mail.createtm + mail.effecttm : 0
    config(uint(expire), 'Malformed mail expiry')
    const category = mail.category ?? 0
    config(Number.isInteger(category) && category >= 0 && category <= 6, 'Malformed mail category')
    const data = {
        mail_id,
        create_time: mail.createtm,
        sender_id: bytes(mail.sender_id),
        template_id: mail.template_id ?? 0,
        args: copy(mail.args ?? []),
        title: bytes(mail.title),
        content: bytes(mail.content),
        reward: { rewards: rewards(mail) },
        visible_time: visible,
        expire_time: expire,
        read: !!mail.read,
        claimed: !!mail.fetch,
        favorite: !!mail.collect,
        category,
    }
    config(uint(data.template_id) && Array.isArray(data.args), 'Malformed mail template or arguments')
    if (mail.gm_id !== undefined) data.gm_id = mailGuid(mail.gm_id, true, ErrorCode.MailConfigError)
    if (mail.business_event_time !== undefined) {
        config(uint(mail.business_event_time), 'Malformed mail business event time')
        data.business_event_time = mail.business_event_time
    }
    return { id: mail_id, data, visible: !mail.is_delete && valid && visible <= now }
}
function unread(mail) {
    return !mail.read || (!mail.claimed && mail.reward.rewards.length > 0)
}
function summary(ledger) {
    const mails = Object.values(ledger.views)
    return {
        total_visible_count: mails.length,
        unread_count: mails.filter(unread).length,
        favorite_count: mails.filter((mail) => mail.favorite).length,
        mailbox_version: ledger.version,
        unclaimed_reward_mail_count: mails.filter((mail) => !mail.claimed && mail.reward.rewards.length > 0).length,
    }
}
function ledger(state) {
    if (state.mailboxV1 === undefined)
        state.mailboxV1 = {
            schema: 1,
            version: '0',
            initialized: false,
            views: {},
            history: [],
            requests: {},
            claims: {},
            all: {},
        }
    const root = state.mailboxV1
    config(
        root &&
            root.schema === 1 &&
            typeof root.initialized === 'boolean' &&
            Array.isArray(root.history) &&
            root.views &&
            root.requests &&
            root.claims &&
            root.all,
        'Malformed mailbox ledger',
    )
    for (const name of ['views', 'requests', 'claims', 'all'])
        config(typeof root[name] === 'object' && !Array.isArray(root[name]), 'Malformed mailbox ledger map')
    mailGuid(root.version, true, ErrorCode.MailConfigError)
    return root
}
export function observeMailbox(tables, state, now) {
    config(uint(now) && Array.isArray(state.mail), 'Malformed mailbox state or clock')
    limits(tables)
    const root = ledger(state),
        next = {},
        ids = new Set()
    for (const mail of state.mail) {
        const converted = view(mail, now)
        config(!ids.has(converted.id), 'Duplicate saved mail identity')
        ids.add(converted.id)
        if (converted.visible) next[converted.id] = converted.data
    }
    const changes = []
    for (const [id, mail] of Object.entries(next))
        if (JSON.stringify(root.views[id]) !== JSON.stringify(mail))
            changes.push({ type: ChangeType.Upsert, mail_id: id, mail })
    for (const id of Object.keys(root.views)) if (!next[id]) changes.push({ type: ChangeType.Delete, mail_id: id })
    let delta = null
    if (!root.initialized || changes.length) {
        const base_version = root.version,
            version = BigInt(base_version) + 1n
        config(version <= 0xffffffffffffffffn, 'Mailbox version exhausted')
        root.version = String(version)
        root.initialized = true
        root.views = next
        delta = { base_version, mailbox_version: root.version, summary: summary(root), changes }
        root.history.push(copy(delta))
    }
    return { root, summary: summary(root), delta }
}
// A narrow bridge for legacy delivery producers (gift code etc.) that already
// mutated state.mail and emitted the retired MailSync name. It never clears mail.
export function mailboxLegacyPush(tables, state, now) {
    const { delta } = observeMailbox(tables, state, now)
    return delta ? { delta } : null
}
function finish(c) {
    const { delta } = observeMailbox(c.tables, c.state, c.now)
    if (delta) c.push('SCProtoMailboxDelta', { delta })
    return delta ?? copy(ledger(c.state).history.at(-1))
}
function remember(c, kind, requestId, input, execute) {
    const root = ledger(c.state),
        key = `${kind}:${requestId}`,
        fingerprint = JSON.stringify(input),
        old = root.requests[key]
    if (old) return old.fingerprint === fingerprint ? copy(old.response) : { code: MailOperationCode.Conflict }
    const response = execute()
    ledger(c.state).requests[key] = { fingerprint, response: copy(response) }
    return response
}
function id(value) {
    return mailGuid(value)
}
function find(c, value) {
    const selected = id(value),
        root = ledger(c.state)
    return root.views[selected] ? c.state.mail.find((mail) => String(mail.guid) === selected) : null
}
function page(c, request) {
    const { root } = observeMailbox(c.tables, c.state, c.now),
        listType = request.list_type
    if (![ListType.All, ListType.Unread, ListType.Favorite].includes(listType))
        return { code: MailOperationCode.UnknownEnum }
    const limit = request.limit || 30
    if (!uint(limit) || limit > limits(c.tables).capacity) return { code: MailOperationCode.InvalidArgument }
    let offset = 0
    const known = mailGuid(request.known_mailbox_version, true, ErrorCode.InvalidArgument)
    if (known !== '0' && known !== root.version)
        return { code: MailOperationCode.Conflict, summary: summary(root), mailbox_version: root.version }
    if (request.cursor) {
        let cursor
        try {
            if (!token(request.cursor)) throw Error()
            cursor = JSON.parse(Buffer.from(request.cursor, 'base64').toString('utf8'))
        } catch {
            return { code: MailOperationCode.InvalidCursor }
        }
        if (cursor.version !== root.version)
            return { code: MailOperationCode.Conflict, summary: summary(root), mailbox_version: root.version }
        if (cursor.type !== listType || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
            return { code: MailOperationCode.InvalidCursor }
        offset = cursor.offset
    }
    const ordered = Object.values(root.views).filter(
        (mail) => listType === ListType.All || (listType === ListType.Unread ? unread(mail) : mail.favorite),
    )
    ordered.sort(
        (a, b) =>
            Number(unread(b)) - Number(unread(a)) ||
            Number(b.favorite) - Number(a.favorite) ||
            b.create_time - a.create_time ||
            (BigInt(a.mail_id) > BigInt(b.mail_id) ? -1 : 1),
    )
    if (offset > ordered.length) return { code: MailOperationCode.InvalidCursor }
    const mails = ordered.slice(offset, offset + limit),
        has_more = offset + mails.length < ordered.length
    return {
        mails: copy(mails),
        cursor: has_more
            ? Buffer.from(
                  JSON.stringify({ version: root.version, type: listType, offset: offset + mails.length }),
              ).toString('base64')
            : '',
        has_more,
        mailbox_version: root.version,
        summary: summary(root),
        code: MailOperationCode.Ok,
    }
}
function claimOne(c, target) {
    const mail_id = id(target.mail_id),
        claim_id = target.claim_id
    if (!token(claim_id) || Buffer.from(claim_id, 'base64').length !== 16)
        return { mail_id, code: MailOperationCode.InvalidArgument, status: ClaimStatus.Failed }
    const key = `c:${claim_id}`,
        old = ledger(c.state).claims[key]
    if (old)
        return old.mail_id === mail_id
            ? copy(old)
            : { mail_id, claim_id, code: MailOperationCode.Conflict, status: ClaimStatus.Failed }
    const mail = find(c, mail_id)
    let result = { mail_id, claim_id, code: MailOperationCode.NotFound, status: ClaimStatus.Failed }
    if (mail) {
        if (mail.fetch || !rewards(mail).length) result.code = MailOperationCode.NoClaimableReward
        else {
            // Reward services may mutate several ledgers before discovering a
            // capacity error. Publish a complete successful private draft only.
            const draft = copy(c.state),
                selected = draft.mail.find((row) => String(row.guid) === mail_id)
            try {
                const granted = grantRewards(c.tables, draft, rewards(selected), 0, { randomInt: c.randomInt })
                selected.fetch = true
                selected.read = true
                Object.assign(c.state, draft)
                result = {
                    mail_id,
                    claim_id,
                    code: MailOperationCode.Ok,
                    status: ClaimStatus.Succeeded,
                    rewards: { rewards: granted },
                }
            } catch (error) {
                if (!capacityErrors.has(error.code)) throw error
                result.code = MailOperationCode.ClaimCapacityFull
            }
        }
    }
    // A capacity failure may be retried with the same claim ID after freeing a
    // slot. Successful and other terminal receipts remain durable across login.
    if (result.code !== MailOperationCode.ClaimCapacityFull) ledger(c.state).claims[key] = copy(result)
    return result
}
function claimCode(results) {
    if (results.every((row) => row.code === MailOperationCode.Ok)) return MailOperationCode.Ok
    const success = results.some((row) => row.code === MailOperationCode.Ok),
        full = results.some((row) => row.code === MailOperationCode.ClaimCapacityFull)
    return full
        ? success
            ? MailOperationCode.ClaimPartialCapacityFull
            : MailOperationCode.ClaimCapacityFull
        : success
          ? MailOperationCode.ClaimPartialFailed
          : (results[0]?.code ?? MailOperationCode.NoClaimableReward)
}
export function registerMailbox(on) {
    on('GetMailboxSummary', (c) => ({
        summary: observeMailbox(c.tables, c.state, c.now).summary,
        code: MailOperationCode.Ok,
    }))
    on('ListMails', page)
    on('SyncMailbox', (c, r) => {
        const { root } = observeMailbox(c.tables, c.state, c.now),
            since = mailGuid(r.since_version, true, ErrorCode.InvalidArgument),
            max = r.max_deltas || 100
        if (!uint(max) || max > limits(c.tables).capacity) return { code: MailOperationCode.InvalidArgument }
        if (BigInt(since) > BigInt(root.version))
            return { code: MailOperationCode.Conflict, mailbox_version: root.version }
        const deltas = root.history.filter((row) => BigInt(row.mailbox_version) > BigInt(since)).slice(0, max)
        return {
            deltas: copy(deltas),
            last_version: deltas.at(-1)?.mailbox_version ?? since,
            has_more: BigInt(deltas.at(-1)?.mailbox_version ?? since) < BigInt(root.version),
            mailbox_version: root.version,
            code: MailOperationCode.Ok,
        }
    })
    on('MailRead', (c, r) => {
        observeMailbox(c.tables, c.state, c.now)
        const mail = find(c, r.mail_id),
            mail_id = id(r.mail_id)
        if (!mail) return { result: { mail_id, code: MailOperationCode.NotFound }, code: MailOperationCode.NotFound }
        mail.read = true
        return { result: { mail_id, code: MailOperationCode.Ok }, delta: finish(c), code: MailOperationCode.Ok }
    })
    on('MailFavorite', (c, r) => {
        observeMailbox(c.tables, c.state, c.now)
        const mail = find(c, r.mail_id),
            mail_id = id(r.mail_id)
        if (!mail) return { result: { mail_id, code: MailOperationCode.NotFound }, code: MailOperationCode.NotFound }
        if (typeof r.favorite !== 'boolean') return { code: MailOperationCode.InvalidArgument }
        if (r.favorite && !mail.collect && summary(ledger(c.state)).favorite_count >= limits(c.tables).favorites)
            return { result: { mail_id, code: MailOperationCode.FavoriteLimit }, code: MailOperationCode.FavoriteLimit }
        mail.collect = r.favorite
        return { result: { mail_id, code: MailOperationCode.Ok }, delta: finish(c), code: MailOperationCode.Ok }
    })
    on('MailDelete', (c, r) => {
        observeMailbox(c.tables, c.state, c.now)
        if (!token(r.request_id)) return { code: MailOperationCode.InvalidArgument }
        if (![Select.MailIds, Select.AllRead].includes(r.selector)) return { code: MailOperationCode.UnknownEnum }
        const selected =
            r.selector === Select.MailIds
                ? (r.mail_ids ?? []).map(id)
                : Object.values(ledger(c.state).views)
                      .filter((m) => m.read)
                      .map((m) => m.mail_id)
        if (!selected.length && r.selector === Select.MailIds) return { code: MailOperationCode.InvalidArgument }
        return remember(
            c,
            'delete',
            r.request_id,
            { selector: r.selector, mail_ids: r.selector === Select.MailIds ? selected : [] },
            () => {
                const results = [...new Set(selected)].map((mail_id) => {
                    const mail = find(c, mail_id)
                    const code = !mail
                        ? MailOperationCode.NotFound
                        : !mail.read || mail.collect || (!mail.fetch && rewards(mail).length)
                          ? MailOperationCode.Protected
                          : MailOperationCode.Ok
                    if (code === MailOperationCode.Ok) mail.is_delete = true
                    return { mail_id, code }
                })
                return { results, delta: finish(c), code: MailOperationCode.Ok, has_more: false }
            },
        )
    })
    on('MailClaim', (c, r) => {
        observeMailbox(c.tables, c.state, c.now)
        if (r.selector !== Select.MailIds) return { code: MailOperationCode.UnknownEnum }
        if (!token(r.request_id) || !Array.isArray(r.mails) || !r.mails.length)
            return { code: MailOperationCode.InvalidArgument }
        if (
            new Set(r.mails.map((target) => id(target.mail_id))).size !== r.mails.length ||
            new Set(r.mails.filter((target) => target.claim_id).map((target) => target.claim_id)).size !==
                r.mails.filter((target) => target.claim_id).length
        )
            return { code: MailOperationCode.InvalidArgument }
        return remember(c, 'claim', r.request_id, r.mails, () => {
            // 1.0 MailStore.RequestClaimMails sends only mail_id. Results
            // require a server-issued, exactly 16-byte ID (MergeClaimResults).
            const results = r.mails.map((target) =>
                    claimOne(c, {
                        ...target,
                        claim_id: target.claim_id || randomBytes(16).toString('base64'),
                    }),
                ),
                delta = finish(c)
            if (results.some((row) => row.code === MailOperationCode.Ok))
                c.pushBefore('CSProtoSyncPlayerData', c.state.player)
            return { results, delta, code: claimCode(results) }
        })
    })
    on('StartMailClaimAll', (c, r) => {
        observeMailbox(c.tables, c.state, c.now)
        const seq = mailGuid(r.request_seq, false, ErrorCode.InvalidArgument),
            session = c.combatSessionId
        ensure(
            typeof session === 'string' && session.length > 0,
            'Missing mailbox connection identity',
            ErrorCode.InvalidLogic,
        )
        const key = `s:${session}:${seq}`,
            old = ledger(c.state).all[key]
        if (old) {
            c.push('SCProtoMailClaimAllUpdate', copy(old.update))
            return copy(old.ack)
        }
        const operation_id = randomUUID(),
            targets = Object.values(ledger(c.state).views)
                .filter((m) => !m.claimed && m.reward.rewards.length)
                .map((m) => ({
                    mail_id: m.mail_id,
                    claim_id: randomBytes(16).toString('base64'),
                })),
            results = targets.map((target) => claimOne(c, target)),
            delta = finish(c)
        const ack = { request_seq: seq, operation_id, state: ClaimAllState.Running, code: MailOperationCode.Ok },
            update = {
                operation_id,
                update_seq: '1',
                state: ClaimAllState.Finished,
                results,
                skipped_results: [],
                delta,
                summary_code: claimCode(results),
                has_pending: false,
            }
        ledger(c.state).all[key] = { ack: copy(ack), update: copy(update) }
        if (results.some((row) => row.code === MailOperationCode.Ok))
            c.pushBefore('CSProtoSyncPlayerData', c.state.player)
        c.push('SCProtoMailClaimAllUpdate', update)
        return ack
    })
}
