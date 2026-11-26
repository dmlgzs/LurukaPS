import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { followActivitySnapshot, claimActivityFollow } from '../src/activity-follow.js'

const cfg = configuration()
const tables = new Tables(cfg.tables)
const event = tables.find('game_events', 15001)
const group = tables.find('game_events_follow_group', event.systemId)
const members = group.showType.split('|').map(Number)
const reward = tables.find('game_events_reward', Number(group.followReward))
function fixture(qualified = true) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let seq = 1,
        session = {},
        packets
    const game = new Game(protocol, store, tables, { clock: () => Date.UTC(2026, 10, 27) / 1000 })
    const frame = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) }
    }
    const dispatch = (request, who = session) => {
        const entry = protocol.byId.get(request.id)
        packets = game.dispatch(who, request)
        return protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload)
    }
    const call = (name, data) => dispatch(frame(name, data))
    const login = () => {
        const next = {}
        const response = dispatch(frame('EnterGame', { open_id: 'follow-current-private' }), next)
        session = next
        return response
    }
    const state = () => store.load(session.id).state
    login()
    if (qualified) {
        // Trusted independent post-main-story qualification, not a story E2E.
        // Both current system34 and the activity require this actual task node.
        const gate = event.condition.split('#').map(Number)
        assert.equal(tables.find('system_unlock', 34).unlockCondi, event.condition)
        assert.equal(gate[0], 12045)
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = [{ task_id: gate[1], count: 1 }]
        })
        login()
    }
    return {
        protocol,
        store,
        game,
        frame,
        dispatch,
        call,
        login,
        state,
        packets: () => packets,
        id: () => session.id,
        claim: (follow_id = members[0]) => call('ActivityFollowReward', { activity_id: event.id, follow_id }),
        close: () => store.close(),
    }
}
const fails = (fn, code) => assert.throws(fn, (e) => e.code === code)
function sync(f) {
    const entry = f.protocol.byName.get('CSProtoActivitySync')
    const packet = f.packets().find((p) => p.id === entry.id)
    assert(packet, 'authoritative activity sync must precede reward display')
    return f.protocol.decode(entry.rsp, packet.payload).activitys.find((a) => a.id === event.id)
}

test('current public source is timed web click, type-level once reward, with table-backed 80 diamonds', () => {
    assert.equal(event.type, 150)
    assert.equal(reward.groupId, event.id)
    assert.equal(reward.finishCondition, '')
    assert.deepEqual(
        members.map((id) => tables.find('game_events_follow', id).type),
        [2, 2, 2, 2],
    )
    const f = fixture()
    try {
        assert.deepEqual(sync(f).data.activity_follow.claimed_types, [])
        const before = f.state().player.basic_info.diamond
        const result = f.claim()
        assert.deepEqual(
            result.rewards.map((r) => [r.itemtype, r.itemid, r.itemnum]),
            [[10, 1, 80]],
        )
        assert.equal(f.state().player.basic_info.diamond, before + 80)
        assert.deepEqual(sync(f).data.activity_follow.claimed_types, [2])
        const responseId = f.protocol.byName.get('CSProtoActivityFollowReward').id
        const syncId = f.protocol.byName.get('CSProtoActivitySync').id
        assert(f.packets().findIndex((p) => p.id === syncId) < f.packets().findIndex((p) => p.id === responseId))
        const same = f.state()
        for (const id of members) fails(() => f.claim(id), ErrorCode.ActivityFollowAlreadyClaimed)
        assert.deepEqual(f.state(), same)
        f.login()
        assert.deepEqual(sync(f).data.activity_follow.claimed_types, [2])
        fails(() => f.claim(), ErrorCode.ActivityFollowAlreadyClaimed)
        const ids = f.packets().map((p) => p.id)
        assert(ids.includes(10400))
    } finally {
        f.close()
    }
})

test('fresh gate, foreign IDs and wrong activity type reject atomically; generic reward route cannot bypass claim rules', () => {
    const locked = fixture(false)
    try {
        const before = locked.state()
        fails(() => locked.claim(), ErrorCode.ActivityNotOpen)
        assert.deepEqual(locked.state(), before)
    } finally {
        locked.close()
    }
    const f = fixture()
    try {
        const before = f.state()
        fails(() => f.claim(2201), ErrorCode.ActivityFollowInvalidId)
        fails(() => f.claim(0xffffffff), ErrorCode.ActivityFollowInvalidId)
        fails(
            () => f.call('ActivityFollowReward', { activity_id: 2002, follow_id: members[0] }),
            ErrorCode.ActivityTypeNotEqual,
        )
        fails(
            () => f.call('ActivityFollowReward', { activity_id: 0xffffffff, follow_id: members[0] }),
            ErrorCode.ActivityNotFond,
        )
        assert.throws(() => f.call('ActivityReward', { activity_id: event.id, reward_id_list: [reward.id] }))
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('response codec and SQL failure retain stock and claim progress, retry grants exactly once', () => {
    const f = fixture()
    try {
        const before = f.store.load(f.id())
        const request = f.frame('ActivityFollowReward', { activity_id: event.id, follow_id: members[0] })
        const encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === 'cs.Rewards') throw Error('follow-response-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.dispatch(request), /follow-response-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.store.load(f.id()), before)
        f.store.db.exec(
            "CREATE TRIGGER follow_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'follow-sql-abort'); END",
        )
        try {
            assert.throws(() => f.dispatch(request), /follow-sql-abort/)
        } finally {
            f.store.db.exec('DROP TRIGGER follow_abort')
        }
        assert.deepEqual(f.store.load(f.id()), before)
        assert.equal(f.dispatch(request).rewards[0].itemnum, 80)
        assert.equal(f.state().player.basic_info.diamond, before.state.player.basic_info.diamond + 80)
        fails(() => f.claim(members[1]), ErrorCode.ActivityFollowAlreadyClaimed)
        f.login()
        assert.deepEqual(sync(f).data.activity_follow.claimed_types, [2])
    } finally {
        f.close()
    }
})

test('snapshot preserves all existing claim lists and rejects damaged current source or ledger', () => {
    const entry = { follow: { claimed_click_ids: [2101], claimed_sdk_ids: [9001], claimed_types: [2] } }
    const original = structuredClone(entry)
    assert.deepEqual(followActivitySnapshot(tables, entry, event), original.follow)
    assert.deepEqual(entry, original)
    for (const value of [null, {}, { claimed_click_ids: [], claimed_sdk_ids: [], claimed_types: [2, 2] }]) {
        fails(() => followActivitySnapshot(tables, { follow: value }, event), ErrorCode.GameConfig)
    }
    const missing = {
        find(name, id) {
            return name === 'game_events_follow_group' ? undefined : tables.find(name, id)
        },
    }
    fails(() => followActivitySnapshot(missing, {}, event), ErrorCode.ActivityExConfNone)
    const incomplete = {
        find(name, id) {
            return name === 'game_events_reward' ? undefined : tables.find(name, id)
        },
    }
    fails(() => followActivitySnapshot(incomplete, {}, event), ErrorCode.ActivityRewardConfNone)
})

test('unrecovered SDK type, extra reward mappings and malformed pools are strict, without touching the context', () => {
    for (const change of [
        { table: 'game_events_follow', patch: { type: 1 }, error: ErrorCode.FunctionClosed },
        {
            table: 'game_events_follow_group',
            patch: { followReward: group.followReward + '|5000007' },
            error: ErrorCode.FunctionClosed,
        },
        { table: 'game_events_reward', patch: { dropId: 'not-a-drop' }, error: ErrorCode.GameConfig },
    ]) {
        const view = {
            find(name, id) {
                const row = tables.find(name, id)
                return row && name === change.table ? { ...row, ...change.patch } : row
            },
        }
        const state = { untouched: [1, 2] }
        const context = { tables: view, state }
        const catalog = {
            rows: [event],
            require() {
                throw Error('validation must finish before mutable activity admission')
            },
        }
        fails(
            () => claimActivityFollow(context, catalog, { activity_id: event.id, follow_id: members[0] }),
            change.error,
        )
        assert.deepEqual(state, { untouched: [1, 2] })
    }
})
