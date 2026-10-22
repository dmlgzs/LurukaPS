import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

function cut(state, peer) {
    const cuts = state.chatConversationCuts
    ensure(
        cuts === undefined || (cuts !== null && typeof cuts === 'object' && !Array.isArray(cuts)),
        'Invalid stored chat conversation cuts',
        ErrorCode.GameConfig,
    )
    const entry = cuts?.[peer]
    if (entry === undefined) return { order: 0, hidden: false }
    ensure(
        entry !== null &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            Number.isInteger(entry.order) &&
            entry.order >= 0 &&
            entry.order <= 0xffffffff &&
            typeof entry.hidden === 'boolean',
        'Invalid stored chat conversation cut',
        ErrorCode.GameConfig,
    )
    return entry
}

export function privateHistory(store, state, account, peer, limit = 100) {
    const cutoff = cut(state, peer).order
    return store.chatHistory(account, peer, limit).filter((r) => r.order > cutoff)
}

export function visibleConversation(state, peer, latestOrder) {
    const data = cut(state, peer)
    return !data.hidden || latestOrder > data.order
}

export function reopenConversation(state, peer) {
    const data = cut(state, peer)
    if (!data.hidden) return
    state.chatConversationCuts = { ...state.chatConversationCuts, [peer]: { ...data, hidden: false } }
}

export function deleteConversation(c, r, store) {
    const peer = r.id
    ensure(
        Number.isInteger(peer) && peer > 0 && peer <= 0xffffffff && peer !== c.id,
        'Invalid chat conversation target',
        ErrorCode.InvalidTarget,
    )
    const data = cut(c.state, peer)
    const last = store.chatHistory(c.id, peer, 1).at(-1)?.order ?? 0
    const order = Math.max(data.order, last)
    const read = c.state.chatReads?.[peer] ?? 0
    ensure(
        Number.isInteger(read) && read >= 0 && read <= 0xffffffff,
        'Invalid stored chat read marker',
        ErrorCode.GameConfig,
    )
    // Archive rows belong to both participants. Clearing one view must never erase the other's history.
    c.state.chatConversationCuts = { ...c.state.chatConversationCuts, [peer]: { order, hidden: true } }
    c.state.chatReads = { ...c.state.chatReads, [peer]: Math.max(read, order) }
    c.pushBefore('CSProtoChatMsgCntSync', { msg_list: [{ id: peer, cnt: 0 }] })
    return {}
}
