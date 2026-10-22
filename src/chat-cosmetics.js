import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const validId = (id) => Number.isInteger(id) && id > 0 && id <= 0xffffffff
const bubble = {
    table: 'chat_bubble',
    key: 'chatBubble',
    use: 'use_bubble',
    unlock: 'unlock_bubble',
    protocol: 'SCProtoChatBubbleSync',
    code: ErrorCode.ChatBubbleNotOpen,
}

function cosmetic(tables, state, spec) {
    const rows = tables.get(spec.table)
    ensure(
        rows.length > 0 &&
            rows.every((r) => validId(r.id) && [0, 1].includes(r.isDefault) && Number.isFinite(r.sort)) &&
            new Set(rows.map((r) => r.id)).size === rows.length,
        `Invalid ${spec.table} configuration`,
        ErrorCode.GameConfig,
    )
    const defaults = rows.filter((r) => r.isDefault === 1).sort((a, b) => a.sort - b.sort || a.id - b.id)
    ensure(defaults.length > 0, `No default ${spec.table} configured`, ErrorCode.GameConfig)
    const data = state[spec.key]
    ensure(
        data === undefined || (data !== null && typeof data === 'object' && !Array.isArray(data)),
        `Invalid stored ${spec.table} state`,
        ErrorCode.GameConfig,
    )
    const unlocked = data?.unlocked ?? []
    ensure(
        Array.isArray(unlocked) &&
            unlocked.every(validId) &&
            new Set(unlocked).size === unlocked.length &&
            unlocked.every((id) => rows.some((r) => r.id === id)),
        `Invalid stored ${spec.table} unlocks`,
        ErrorCode.GameConfig,
    )
    const owned = new Set([...defaults.map((r) => r.id), ...unlocked])
    const current = data?.use ?? defaults[0].id
    ensure(validId(current) && owned.has(current), `Invalid stored ${spec.table} selection`, ErrorCode.GameConfig)
    return { [spec.use]: current, [spec.unlock]: [...owned].sort((a, b) => a - b) }
}

function changeCosmetic(c, r, spec) {
    const id = r.u32
    ensure(validId(id), `Invalid ${spec.table} selection`, ErrorCode.InvalidArgument)
    const data = cosmetic(c.tables, c.state, spec)
    ensure(data[spec.unlock].includes(id), `Selected ${spec.table} is not available`, spec.code)
    c.state[spec.key] = { ...c.state[spec.key], use: id }
    c.pushBefore(spec.protocol, { ...data, [spec.use]: id })
    return {}
}

export const chatBubbleSnapshot = (tables, state) => cosmetic(tables, state, bubble)
export const changeChatBubble = (c, r) => changeCosmetic(c, r, bubble)

export function selectedChatBubble(tables, state, requested = 0) {
    const data = chatBubbleSnapshot(tables, state)
    ensure(
        Number.isInteger(requested) && requested >= 0 && requested <= 0xffffffff,
        'Invalid message bubble',
        ErrorCode.InvalidArgument,
    )
    ensure(
        requested === 0 || data.unlock_bubble.includes(requested),
        'Message bubble is not available',
        ErrorCode.ChatBubbleNotOpen,
    )
    // A stale client-provided message field cannot override the account's selected cosmetic.
    return data.use_bubble
}
