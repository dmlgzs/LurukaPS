import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { legacyChatBans } from './chat-shields.js'

function peerId(value) {
    ensure(
        Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff,
        'Invalid friend identity',
        ErrorCode.InvalidTarget,
    )
    return value
}
function ids(values, label) {
    ensure(Array.isArray(values), 'Invalid ' + label + ' list', ErrorCode.GameConfig)
    const result = values.map((id) => {
        ensure(
            Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff,
            'Invalid saved ' + label + ' identity',
            ErrorCode.GameConfig,
        )
        return id
    })
    ensure(new Set(result).size === result.length, 'Repeated ' + label + ' identity', ErrorCode.GameConfig)
    return result
}
function times(value, label) {
    const result = value ?? {}
    ensure(
        result && typeof result === 'object' && !Array.isArray(result),
        'Invalid ' + label + ' ledger',
        ErrorCode.GameConfig,
    )
    for (const [key, time] of Object.entries(result)) {
        const id = Number(key)
        ensure(
            Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff && String(id) === key,
            'Invalid ' + label + ' identity',
            ErrorCode.GameConfig,
        )
        ensure(
            (typeof time === 'string' || Number.isSafeInteger(time)) &&
                /^(0|[1-9]\d*)$/.test(String(time)) &&
                BigInt(time) <= 0xffffffffffffffffn,
            'Invalid ' + label + ' time',
            ErrorCode.GameConfig,
        )
    }
    return result
}
export function friendLists(state) {
    return {
        friends: ids(state.friends ?? [], 'friend'),
        bans: [...legacyChatBans(state)],
        applications: times(state.friendApplications, 'friend application'),
        friendTimes: times(state.friendTimes, 'friend'),
        banTimes: times(state.blockedPlayerTimes, 'blocked player'),
    }
}
export function friendSnapshot(state) {
    const list = friendLists(state)
    return {
        info: {
            friends: list.friends.map((id) => ({ id, time: String(list.friendTimes[id] ?? 0) })),
            apply: Object.entries(list.applications).map(([id, time]) => ({ id: Number(id), time: String(time) })),
            ban: list.bans.map((id) => ({ id, time: String(list.banTimes[id] ?? 0) })),
            // No producer for recent-team history is invented by this operation.
        },
    }
}
export function friendLoginSnapshots(state) {
    try {
        return [friendSnapshot(state)]
    } catch (error) {
        // An optional damaged social ledger must not prevent unrelated gameplay
        // login. Do not overwrite it with a fabricated empty friend list.
        console.warn('[friend-sync] invalid saved social data; snapshot omitted: ' + error.message)
        return []
    }
}
function limits(tables) {
    const row = tables.get('game').find((r) => r.title === 'FRIEND_LIMITS'),
        values = String(row?.value ?? '')
            .split('|')
            .map(Number)
    ensure(
        values.length === 3 && values.every((n) => Number.isSafeInteger(n) && n >= 0),
        'Friend limits configuration is invalid',
        ErrorCode.FriendCfgErr,
    )
    return { friends: values[0], applications: values[1], bans: values[2] }
}
function setApplication(state, peer, time) {
    const next = { ...state.friendApplications }
    if (time === undefined) delete next[peer]
    else next[peer] = time
    state.friendApplications = next
}
function setFriend(state, peer, add, time) {
    const next = new Set(state.friends ?? []),
        meta = { ...state.friendTimes }
    if (add) {
        next.add(peer)
        meta[peer] ??= time
    } else {
        next.delete(peer)
        delete meta[peer]
    }
    state.friends = [...next]
    state.friendTimes = meta
}
export function operateFriend(c, r, store) {
    ensure(
        [1, 2, 3].includes(r.optype) && [1, 2, 3, 4].includes(r.op),
        'Invalid friend operation',
        ErrorCode.FriendOpIsFail,
    )
    ensure(typeof c.editPlayer === 'function', 'Friend transaction context is unavailable', ErrorCode.GameConfig)
    const own = friendLists(c.state),
        max = limits(c.tables)
    ensure(
        Number.isSafeInteger(c.now) && c.now > 0 && c.now <= 0xffffffff,
        'Invalid friend clock',
        ErrorCode.GameConfig,
    )
    const time = String(c.now)
    const changes = new Map()
    const notify = (owner, peer, type, at = time) => {
        if (!changes.has(owner)) changes.set(owner, [])
        changes.get(owner).push({ friendItem: { id: peer, time: at }, type })
    }
    const target = (id) => {
        peerId(id)
        ensure(id !== c.id, 'Cannot operate on yourself', ErrorCode.CannotOptYourSelf)
        ensure(store.hasPlayer(id), 'Friend target does not exist', ErrorCode.InvalidTarget)
        const state = c.editPlayer(id)
        return { state, list: friendLists(state) }
    }
    const canConnect = (peer, list) => {
        ensure(!own.bans.includes(peer), 'You have blocked this player', ErrorCode.YouBanTarget)
        ensure(!list.bans.includes(c.id), 'Target has blocked you', ErrorCode.TargetBanYou)
    }
    const accept = (peer) => {
        const other = target(peer)
        canConnect(peer, other.list)
        ensure(
            Object.hasOwn(c.state.friendApplications ?? {}, peer),
            'No incoming friend application',
            ErrorCode.FriendOpIsFail,
        )
        ensure(!c.state.friends?.includes(peer), 'Already friends', ErrorCode.HadFriend)
        ensure((c.state.friends ?? []).length < max.friends, 'Friend list is full', ErrorCode.FriendNumMax)
        ensure(other.list.friends.length < max.friends, 'Target friend list is full', ErrorCode.TargetFriendNumMax)
        setFriend(c.state, peer, true, time)
        setFriend(other.state, c.id, true, time)
        setApplication(c.state, peer)
        setApplication(other.state, c.id)
        notify(c.id, peer, 1 | 32)
        notify(peer, c.id, 1 | 32)
    }
    const bulk = r.op === 3 || r.op === 4
    if (bulk) {
        ensure(r.id === 0xffffffff, 'Batch friend operation needs the client sentinel', ErrorCode.FriendOpIsFail)
        ensure(
            (r.optype === 1 && r.op === 3) || (r.optype === 2 && r.op === 4),
            'Unsupported friend batch operation',
            ErrorCode.FriendOpIsFail,
        )
        if (r.op === 3) {
            // Local atomic batch policy: every incoming application must pass
            // validation. A full/blocked target leaves the entire batch intact.
            for (const peer of Object.keys(own.applications).map(Number)) accept(peer)
        } else {
            c.state.friendApplications = {}
            // The receiver tests ClearApplyList independently of friendItem.
            notify(c.id, 0, 64)
        }
    } else {
        const peer = peerId(r.id),
            other = target(peer)
        if (r.optype === 2 && r.op === 1) {
            canConnect(peer, other.list)
            ensure(!own.friends.includes(peer), 'Already friends', ErrorCode.HadFriend)
            ensure(own.friends.length < max.friends, 'Friend list is full', ErrorCode.FriendNumMax)
            ensure(other.list.friends.length < max.friends, 'Target friend list is full', ErrorCode.TargetFriendNumMax)
            ensure(
                !Object.hasOwn(other.list.applications, c.id),
                'Target already has your application',
                ErrorCode.TargetGetYourApply,
            )
            ensure(
                Object.keys(other.list.applications).length < max.applications,
                'Target application list is full',
                ErrorCode.TargetFriendApplyNumMax,
            )
            setApplication(other.state, c.id, time)
            notify(peer, c.id, 4)
        } else if (r.optype === 2 && r.op === 2) {
            setApplication(c.state, peer)
            notify(c.id, peer, 32)
        } else if (r.optype === 1 && r.op === 1) accept(peer)
        else if (r.optype === 1 && r.op === 2) {
            setFriend(c.state, peer, false)
            setFriend(other.state, c.id, false)
            notify(c.id, peer, 8)
            notify(peer, c.id, 8)
        } else if (r.optype === 3) {
            const add = r.op === 1,
                exists = own.bans.includes(peer)
            if (add && !exists) ensure(own.bans.length < max.bans, 'Blocked list is full', ErrorCode.BanNumMax)
            const next = new Set(own.bans),
                meta = { ...c.state.blockedPlayerTimes }
            if (add) {
                next.add(peer)
                meta[peer] ??= time
            } else {
                next.delete(peer)
                delete meta[peer]
            }
            c.state.blockedPlayers = [...next]
            c.state.blockedPlayerTimes = meta
            if (add) {
                setFriend(c.state, peer, false)
                setFriend(other.state, c.id, false)
                setApplication(c.state, peer)
                setApplication(other.state, c.id)
                notify(c.id, peer, 2 | 8 | 32, meta[peer])
                notify(peer, c.id, 8 | 32)
            } else notify(c.id, peer, 16)
        }
    }
    for (const [owner, datalist] of changes) {
        if (owner === c.id) c.pushBefore('CSProtoFriendIncChange', { datalist })
        else c.pushTo(owner, 'CSProtoFriendIncChange', { datalist })
    }
    return {}
}
