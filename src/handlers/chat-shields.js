import { changeChatShield } from '../chat-shields.js'
export function registerChatShields(on, store) {
    on('ChatShieldOp', (c, r) => changeChatShield(c, r, store))
}
