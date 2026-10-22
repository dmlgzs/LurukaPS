import { changeChatEmoji } from '../chat-emoji.js'
import { changeChatBubble, changeChatBackground } from '../chat-cosmetics.js'

export function registerChatCustomization(on) {
    on('CollectChatEmojiChange', changeChatEmoji)
    on('ChatBubbleChangeReq', changeChatBubble)
    on('ChatBackgroundChangeReq', changeChatBackground)
}
