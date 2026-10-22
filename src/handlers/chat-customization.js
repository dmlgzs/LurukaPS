import { changeChatEmoji } from '../chat-emoji.js'

export function registerChatCustomization(on) {
    on('CollectChatEmojiChange', changeChatEmoji)
}
