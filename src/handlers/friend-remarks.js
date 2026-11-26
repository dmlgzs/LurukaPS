import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { friendLists } from '../friends.js'
import { saveFriendRemark } from '../friend-remarks.js'
export function registerFriendRemarks(on, store) {
    on('ChangeFriendRemark', (c, request) => {
        ensure(
            Number.isSafeInteger(request.id) && request.id > 0 && request.id <= 0xffffffff,
            'Invalid friend remark target',
            ErrorCode.InvalidTarget,
        )
        ensure(request.id !== c.id, 'Cannot remark yourself', ErrorCode.CannotOptYourSelf)
        ensure(store.hasPlayer(request.id), 'Friend remark target does not exist', ErrorCode.InvalidTarget)
        ensure(
            friendLists(c.state).friends.includes(request.id),
            'Target is not your friend',
            ErrorCode.TargetIsNotYourFriend,
        )
        const system = c.tables.find('system_unlock', 1104)
        ensure(system, 'Current friend remark access configuration is missing', ErrorCode.FriendCfgErr)
        ensure(
            system.homeUnlock === 0 && system.unlockCondi === '',
            'Current friend remark access configuration is unsupported',
            ErrorCode.FunctionClosed,
        )
        // Private owner-only state: no editPlayer/pushTo, nickname changes or
        // claim of an unavailable external sensitive-word backend.
        return saveFriendRemark(c.tables, c.state, request.id, request.remark)
    })
}
