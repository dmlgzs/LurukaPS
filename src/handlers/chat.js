import { ensure } from './common.js'
import { publicProfile } from '../public-profile.js'
import { ErrorCode } from '../error-codes.js'
import { isChatMuted, legacyChatBans, chatRoutingInfo } from '../chat-shields.js'
import { selectedChatBubble } from '../chat-cosmetics.js'
function peerId(value) {
    const id = Number(value)
    ensure(Number.isInteger(id) && id > 0 && id <= 0xffffffff, 'Invalid chat recipient')
    return id
}
export function chatSnapshots(store, state, id) {
    const peers = store.chatPeers(id)
    return {
        list: {
            info: peers.map((peer) => ({
                id: peer,
                chats: isChatMuted(state, peer) ? [] : store.chatHistory(id, peer, 1),
                read_order: state.chatReads?.[peer] ?? 0,
            })),
        },
        counts: {
            msg_list: peers.map((peer) => ({
                id: peer,
                cnt: isChatMuted(state, peer) ? 0 : store.chatUnread(id, peer, state.chatReads?.[peer] ?? 0),
            })),
        },
    }
}
export function registerChat(on, store, { runGM } = {}) {
    on('ChatRoomNum', (c, r) => {
        ensure(r.chat_type === 2, 'Room numbers are for world chat')
        return { chat_type: 2, count: store.maxWorldChatRoom() }
    })
    on('ChatWorldJoin', (c, r) => {
        const room = peerId(r.sysId)
        ensure(room <= store.maxWorldChatRoom(), 'World chat room does not exist')
        c.state.chatWorldRoom = room
        c.pushBefore('CSProtoChatRoomSync', { chat_type: 2, sysId: String(room) })
        return {}
    })
    const exists = (id) => {
        ensure(store.hasPlayer(id), 'Chat recipient not found', ErrorCode.InvalidTarget)
        return chatRoutingInfo(store, id)
    }
    const history = (c, id) => {
        const peer = peerId(id)
        exists(peer)
        return {
            id: peer,
            chats: isChatMuted(c.state, peer) ? [] : store.chatHistory(c.id, peer),
            read_order: c.state.chatReads?.[peer] ?? 0,
        }
    }
    on('AddChat', (c, r) => {
        const type = r.target?.chat_type ?? 0
        ensure([0, 1, 2, 3].includes(type), 'Unknown chat channel')
        const bytes = Buffer.from(r.msg ?? '', 'base64'),
            extra = Buffer.from(r.extra_info ?? '', 'base64')
        ensure(bytes.length > 0 && bytes.length <= 4096 && extra.length <= 8192, 'Invalid chat size')
        ensure([0, 1, 2].includes(r.type ?? 0), 'Unknown chat content type')
        let text
        if ((r.type ?? 0) === 0) {
            try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            } catch {
                ensure(false, 'Chat text is not UTF-8')
            }
            ensure(text.trim().length > 0 && !text.includes('\0'), 'Empty/invalid chat text')
        }
        if (type === 2 && text?.startsWith('/')) {
            ensure(runGM, 'GM command handler unavailable')
            runGM(c, text.slice(1))
            return { ban_time: 0 }
        }
        let target = String(r.target?.tid ?? '0'),
            recipients = [],
            broadcast
        if (type === 0) {
            const peer = peerId(target),
                state = exists(peer)
            ensure(!state.banInvalid, 'Recipient blacklist state is unavailable', ErrorCode.GameConfig)
            ensure(!state.bans.has(c.id), 'Chat recipient has blacklisted you', ErrorCode.TargetBanYou)
            ensure(!legacyChatBans(c.state).has(peer), 'Chat recipient is blacklisted', ErrorCode.YouBanTarget)
            recipients = [peer]
            target = String(peer)
        } else if (type === 1) {
            const members = c.state.chatGroups?.[target]
            ensure(Array.isArray(members) && members.includes(c.id), 'Not a member of this chat group')
            recipients = [...new Set(members.map(peerId))]
            recipients.forEach(exists)
        } else if (type === 2) {
            target = String(
                peerId(target === '0' || target === '18446744073709551615' ? (c.state.chatWorldRoom ?? 1) : target),
            )
            c.state.chatWorldRoom = Number(target)
            broadcast = { kind: 'world', room: Number(target), sender: c.id }
        } else {
            target = String(c.state.world.map_id)
            broadcast = { kind: 'map', map: c.state.world.map_id, sender: c.id }
        }
        const info = store.appendChat(c.id, type, target, c.state.world.map_id, {
            msg: bytes.toString('base64'),
            time: c.now,
            type: r.type ?? 0,
            player_id: c.id,
            basic_info: publicProfile(c.state.player.basic_info),
            extra_info: extra.toString('base64'),
            bubbleId: selectedChatBubble(c.tables, c.state, r.bubbleId ?? 0),
            language: r.language ?? c.state.player.basic_info.language ?? 1,
        })
        const value = { target: { tid: target, chat_type: type }, chat: info }
        c.push('CSProtoChatInfoChange', value)
        for (const recipient of recipients)
            if (recipient !== c.id) {
                const route = chatRoutingInfo(store, recipient)
                if (route.blocked === null || route.blocked.has(c.id)) continue
                c.pushTo(recipient, 'CSProtoChatInfoChange', {
                    ...value,
                    target: { tid: type === 0 ? String(c.id) : target, chat_type: type },
                })
                if (type === 0)
                    c.pushTo(recipient, 'CSProtoChatMsgCntSync', {
                        msg_list: [{ id: c.id, cnt: store.chatUnread(recipient, c.id, route.reads[c.id] ?? 0) }],
                    })
            }
        if (broadcast) c.broadcast(broadcast, 'CSProtoChatInfoChange', value)
        return { ban_time: 0 }
    })
    on('ChatInfoSync', (c, r) => history(c, r.id))
    on('ChatSyncNew', (c, r) => {
        ensure((r.pids ?? []).length <= 50, 'Too many chat histories')
        return { chat_infos: [...new Set(r.pids ?? [])].map((id) => history(c, id)) }
    })
    on('ReadFriendChat', (c, r) => {
        const peer = peerId(r.id)
        exists(peer)
        const last = store.chatHistory(c.id, peer, 1).at(-1)?.order ?? 0
        ensure(Number.isInteger(r.order ?? 0) && (r.order ?? 0) <= last, 'Invalid chat read marker')
        c.state.chatReads ??= {}
        c.state.chatReads[peer] = Math.max(c.state.chatReads[peer] ?? 0, r.order ?? 0)
        c.push('CSProtoChatMsgCntSync', {
            msg_list: [{ id: peer, cnt: store.chatUnread(c.id, peer, c.state.chatReads[peer]) }],
        })
        return {}
    })
    on('CreateFriendChat', (c, r) => {
        const peer = peerId(r.id)
        exists(peer)
        c.state.chatReads ??= {}
        c.state.chatReads[peer] ??= 0
        c.push('CSProtoChatListSync', { info: [history(c, peer)] })
        return { upgrade: 0 }
    })
}
