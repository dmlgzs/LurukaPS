import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const validId = (id) => Number.isInteger(id) && id > 0 && id <= 0xffffffff
function storedIds(value, label) {
    if (value === undefined) return []
    ensure(
        Array.isArray(value) && value.every(validId) && new Set(value).size === value.length,
        `Invalid stored chat emoji ${label}`,
        ErrorCode.GameConfig,
    )
    return value
}

export function chatEmojiSnapshot(tables, state) {
    const rows = tables.get('chat_emoji')
    ensure(
        rows.length > 0 &&
            rows.every((r) => validId(r.id) && [0, 1].includes(r.isDefault)) &&
            new Set(rows.map((r) => r.id)).size === rows.length,
        'Invalid chat emoji table',
        ErrorCode.GameConfig,
    )
    const data = state.chatEmoji
    ensure(
        data === undefined || (data !== null && typeof data === 'object' && !Array.isArray(data)),
        'Invalid stored chat emoji state',
        ErrorCode.GameConfig,
    )
    const catalogue = new Set(rows.map((r) => r.id))
    const unlocked = storedIds(data?.unlocked, 'unlocks')
    ensure(
        unlocked.every((id) => catalogue.has(id)),
        'Stored chat emoji is missing from table',
        ErrorCode.GameConfig,
    )
    const owned = new Set([...rows.filter((r) => r.isDefault === 1).map((r) => r.id), ...unlocked])
    const collects = storedIds(data?.collects, 'favorites')
    const recent = storedIds(data?.recent, 'recent list')
    ensure(
        [...collects, ...recent].every((id) => owned.has(id)),
        'Stored chat emoji is not owned',
        ErrorCode.GameConfig,
    )
    return {
        bags: [...owned].sort((a, b) => a - b).map((id) => ({ id })),
        collects: [...collects],
        lately_collects: [...recent],
    }
}

// CHAT_EMOJI sends tostring(configId) as bytes, not arbitrary chat text.
export function prepareChatEmojiUse(tables, state, bytes) {
    ensure(
        bytes.length > 0 && bytes.length <= 10 && bytes[0] !== 48 && bytes.every((byte) => byte >= 48 && byte <= 57),
        'Chat emoji message must be a canonical decimal ID',
        ErrorCode.InvalidArgument,
    )
    const id = Number(bytes.toString('utf8'))
    ensure(validId(id), 'Chat emoji ID is outside its wire range', ErrorCode.InvalidArgument)
    ensure(tables.find('chat_emoji', id), 'Unknown chat emoji configuration', ErrorCode.ChatEmojiConfigNotExist)
    const snapshot = chatEmojiSnapshot(tables, state)
    ensure(
        snapshot.bags.some((row) => row.id === id),
        'Chat emoji is not owned',
        ErrorCode.ChatEmojiHadNot,
    )
    const limit = Number(tables.get('game').find((row) => row.title === 'CHAT_EMOJI_COLLECT_RECENTLY_NUM_MAX')?.value)
    ensure(validId(limit), 'Invalid recent chat emoji capacity', ErrorCode.GameConfig)
    // Local LRU policy: latest successful use first, unique IDs, table capacity.
    // TODO: the official backend's recent ordering algorithm is not recovered.
    return {
        ...snapshot,
        lately_collects: [id, ...snapshot.lately_collects.filter((other) => other !== id)].slice(0, limit),
    }
}

export function changeChatEmoji(c, r) {
    const ids = r.u32s ?? []
    ensure(Array.isArray(ids) && ids.every(validId), 'Invalid chat emoji favorites', ErrorCode.InvalidArgument)
    const limit = Number(c.tables.get('game').find((r) => r.title === 'CHAT_EMOJI_COLLECT_NUM_MAX')?.value)
    ensure(Number.isInteger(limit) && limit > 0, 'Missing chat emoji favorite limit', ErrorCode.GameConfig)
    ensure(ids.length <= limit, 'Chat emoji favorite list is full', ErrorCode.CollectChatEmojiNumIsMax)
    ensure(new Set(ids).size === ids.length, 'Duplicate chat emoji in favorites', ErrorCode.ReqHasSameChatEmoji)
    const snapshot = chatEmojiSnapshot(c.tables, c.state)
    const owned = new Set(snapshot.bags.map((r) => r.id))
    for (const id of ids) {
        ensure(c.tables.find('chat_emoji', id), 'Unknown chat emoji configuration', ErrorCode.ChatEmojiConfigNotExist)
        ensure(owned.has(id), 'Chat emoji is not owned', ErrorCode.ChatEmojiHadNot)
    }
    // The client sends the entire ordered selection, including an empty list to clear it.
    c.state.chatEmoji = { ...c.state.chatEmoji, collects: [...ids] }
    c.pushBefore('CSProtoChatEmojiSync', { ...snapshot, collects: [...ids] })
    return {}
}
