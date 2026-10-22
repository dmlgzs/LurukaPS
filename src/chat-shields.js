import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const routes = new WeakMap()
function caches(store) {
    if (!routes.has(store)) routes.set(store, { entries: new Map(), warned: new Set() })
    return routes.get(store)
}
export function shieldPeerId(value) {
    const id = Number(value)
    ensure(Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff, 'Invalid chat shield player')
    return id
}
export function chatShieldItems(state) {
    const saved = state.chatShields
    if (saved === undefined) return []
    ensure(
        saved && typeof saved === 'object' && !Array.isArray(saved),
        'Malformed chat shield ledger',
        ErrorCode.GameConfig,
    )
    return Object.entries(saved)
        .map(([key, time]) => {
            const id = Number(key)
            ensure(
                Number.isSafeInteger(id) &&
                    id > 0 &&
                    id <= 0xffffffff &&
                    String(id) === key &&
                    Number.isSafeInteger(time) &&
                    time >= 0 &&
                    time <= 0xffffffff,
                'Malformed chat shield record',
                ErrorCode.GameConfig,
            )
            return { pid: id, time }
        })
        .sort((a, b) => b.time - a.time || a.pid - b.pid)
}
export function isChatMuted(state, peer) {
    return chatShieldItems(state).some((row) => row.pid === peer)
}
export function legacyChatBans(state) {
    const saved = state.blockedPlayers ?? []
    ensure(Array.isArray(saved), 'Malformed legacy blocked-player list', ErrorCode.GameConfig)
    return new Set(
        saved.map((value) => {
            const id = Number(value)
            ensure(
                (typeof value === 'number' || /^\d+$/.test(String(value))) &&
                    Number.isSafeInteger(id) &&
                    id > 0 &&
                    id <= 0xffffffff,
                'Malformed legacy blocked player',
                ErrorCode.GameConfig,
            )
            return id
        }),
    )
}

// The cache contains routing metadata only, never a borrowed whole profile.
export function chatRoutingInfo(store, id) {
    const owner = caches(store),
        token = store.readCacheToken(id),
        cached = owner.entries.get(id)
    if (cached?.token === token) return cached
    const value = store.read(id, (state) => {
        let items = [],
            bans = new Set(),
            muteInvalid = false,
            banInvalid = false
        try {
            items = chatShieldItems(state)
        } catch {
            muteInvalid = true
        }
        try {
            bans = legacyChatBans(state)
        } catch {
            banInvalid = true
        }
        return {
            map: state.world?.map_id,
            room: state.chatWorldRoom ?? 1,
            reads: { ...state.chatReads },
            items,
            bans,
            muteInvalid,
            banInvalid,
            blocked: muteInvalid || banInvalid ? null : new Set([...bans, ...items.map((r) => r.pid)]),
        }
    })
    if (value.muteInvalid || value.banInvalid) {
        if (!owner.warned.has(id)) {
            owner.warned.add(id)
            console.warn('[chat-shield] invalid privacy metadata for account ' + id + '; chat delivery suppressed')
            if (owner.warned.size > 4096) owner.warned.delete(owner.warned.values().next().value)
        }
    } else owner.warned.delete(id)
    const result = { token, ...value }
    if (!owner.entries.has(id) && owner.entries.size >= 4096) owner.entries.delete(owner.entries.keys().next().value)
    owner.entries.set(id, result)
    return result
}
export function audienceAllows(route, audience, isChat) {
    const matches = audience.kind === 'world' ? route.room === audience.room : route.map === audience.map
    return matches && (!isChat || (route.blocked !== null && !route.blocked.has(audience.sender)))
}
export function shieldReply(state) {
    return { err: ErrorCode.Succ, items: chatShieldItems(state) }
}

export function getChatShieldList(store, id) {
    const route = chatRoutingInfo(store, id)
    ensure(!route.muteInvalid, 'Malformed chat shield ledger', ErrorCode.GameConfig)
    return { err: ErrorCode.Succ, items: route.items.map((row) => ({ ...row })) }
}

export function changeChatShield(c, request, store) {
    const peer = shieldPeerId(request.tar_id)
    ensure(peer !== c.id, 'Cannot mute your own chat', ErrorCode.InvalidTarget)
    ensure([1, 2].includes(request.op), 'Invalid chat shield operation', ErrorCode.FriendOpIsFail)
    const items = chatShieldItems(c.state),
        exists = items.some((row) => row.pid === peer)
    const adding = request.op === 1
    if (adding === exists) return shieldReply(c.state)
    if (adding) {
        ensure(store.hasPlayer(peer), 'Chat shield player does not exist', ErrorCode.InvalidTarget)
        const limit = Number(c.tables.get('game').find((row) => row.title === 'CHAT_SHIELD_LIMIT')?.value)
        ensure(Number.isSafeInteger(limit) && limit >= 0, 'Invalid chat shield limit', ErrorCode.GameConfig)
        ensure(items.length < limit, 'Chat shield list reached its configured limit', ErrorCode.BanNumMax)
        ensure(
            Number.isFinite(c.now) && c.now >= 0 && c.now <= 0xffffffff,
            'Invalid chat shield clock',
            ErrorCode.GameConfig,
        )
    }
    const next = { ...c.state.chatShields }
    if (adding) next[peer] = Math.floor(c.now)
    else delete next[peer]
    c.state.chatShields = next
    // Local archive policy: retain history, but consume notification orders
    // through the mute/unmute transition. Do not replay a muted unread burst.
    const previous = c.state.chatReads?.[peer] ?? 0
    ensure(
        Number.isSafeInteger(previous) && previous >= 0 && previous <= 0xffffffff,
        'Malformed chat read marker',
        ErrorCode.GameConfig,
    )
    const last = store.chatHistory(c.id, peer, 1).at(-1)?.order ?? 0
    c.state.chatReads = { ...c.state.chatReads, [peer]: Math.max(previous, last) }
    c.pushBefore('CSProtoChatMsgCntSync', { msg_list: [{ id: peer, cnt: 0 }] })
    return shieldReply(c.state)
}
