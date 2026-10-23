import { operateFriend } from '../friends.js'
export function registerFriends(on, store) {
    on('OpFriend', (c, r) => operateFriend(c, r, store))
}
