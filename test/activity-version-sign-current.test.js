import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { versionSignSnapshot } from '../src/activity-version-sign.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    log = fileURLToPath(
        new URL(
            '../../work/obt-runtime-errors-20261126/cross-session/activity/version-sign-reward-source.jsonl',
            import.meta.url,
        ),
    ),
    previousLog = process.env.LURUKAPS_REWARD_SOURCE_LOG
process.env.LURUKAPS_REWARD_SOURCE_LOG = log
after(() => {
    if (previousLog === undefined) delete process.env.LURUKAPS_REWARD_SOURCE_LOG
    else process.env.LURUKAPS_REWARD_SOURCE_LOG = previousLog
})

function fixture({ unlocked = true, prepareTables, now: initial = Date.UTC(2026, 10, 26, 19, 59, 50) / 1000 } = {}) {
    const tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    prepareTables?.(tables)
    let now = initial,
        seq = 1,
        session = {},
        loginPackets
    const game = new Game(protocol, store, tables, { clock: () => now }),
        frame = (name, data = {}) => {
            const entry = protocol.byName.get('CSProto' + name)
            assert(entry)
            return { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) }
        },
        dispatch = (request, who = session) => {
            const entry = protocol.byId.get(request.id),
                packets = game.dispatch(who, request)
            return {
                packets,
                data: protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload),
            }
        },
        call = (name, data) => dispatch(frame(name, data)),
        login = () => {
            const next = {}
            const result = dispatch(frame('EnterGame', { open_id: 'version-sign-current' }), next)
            session = next
            loginPackets = result.packets
            return result
        }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    if (unlocked) {
        edit((s) => {
            s.taskRecords = [{ task_id: 106010, count: 1 }]
            s.tasks = []
        })
        login()
    }
    return {
        tables,
        protocol,
        store,
        game,
        frame,
        dispatch,
        call,
        login,
        edit,
        state,
        loginPackets,
        advance: (seconds) => {
            now += seconds
        },
        setNow: (value) => {
            now = value
        },
        sign: () => state().activities?.[2002]?.versionSign,
        tickets: () =>
            state()
                .player.sbag_infos.items.filter((item) => item.itemid === 501001)
                .reduce((sum, item) => sum + item.itemnum, 0),
        close: () => store.close(),
    }
}

test('current10428 publishes nonnull VersionSign, grants real2D-table tickets, logs unknown source without blocking, and replays no reward', () => {
    const f = fixture()
    try {
        const sync = f.protocol.byName.get('CSProtoActivitySync'),
            snapshot = f.protocol.decode(sync.rsp, f.loginPackets.find((packet) => packet.id === sync.id).payload),
            entry = snapshot.activitys.find((activity) => activity.id === 2002)
        assert.deepEqual(entry.data.version_sign, { count: 1, time: f.sign().time, reward_count: 0 })
        const request = f.frame('ActivityVersionSign', { u32: 2002 }),
            before = f.tickets(),
            warn = console.warn
        let result
        console.warn = () => {
            throw Error('source-console-unavailable')
        }
        try {
            result = f.dispatch(request)
        } finally {
            console.warn = warn
        }
        assert.equal(f.tickets(), before + 1)
        assert(
            result.data.rewards.some(
                (reward) => reward.itemtype === 3 && reward.itemid === 501001 && reward.itemnum === 1,
            ),
        )
        assert.equal(f.sign().reward_count, 1)
        assert(
            fs
                .readFileSync(log, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
                .some(
                    (row) =>
                        row.operation === 'activityVersionSign' &&
                        row.reason === 'unknown_operation' &&
                        row.fallback === 'omit_src',
                ),
        )
        assert.equal(result.data.src, undefined)
        const ack = result.packets.findIndex((packet) => packet.id === 10428)
        assert(result.packets.findIndex((packet) => packet.id === sync.id) < ack)
        assert(
            result.packets.findIndex((packet) => packet.id === f.protocol.byName.get('CSProtoSyncPlayerData').id) < ack,
        )
        assert.deepEqual(f.dispatch(request).data.rewards, [])
        f.advance(10) // Cross the table's04:00 business-day boundary on the same connection.
        assert.deepEqual(f.dispatch(request).data.rewards, [])
        assert.equal(f.sign().count, 2)
        assert.equal(f.sign().reward_count, 1)
        f.call('ActivityVersionSign', { u32: 2002 })
        assert.equal(f.tickets(), before + 2)
        const claimed = structuredClone(f.sign()),
            player = f.state().player
        f.login()
        assert.deepEqual(f.sign(), claimed)
        for (const field of ['sbag_infos', 'attr_infos', 'heros_info', 'soulessence_infos'])
            assert.deepEqual(f.state().player[field], player[field])
        for (const currency of ['gold', 'diamond'])
            assert.equal(f.state().player.basic_info[currency], player.basic_info[currency])
        assert.deepEqual(f.call('ActivityVersionSign', { u32: 2002 }).data.rewards, [])
    } finally {
        f.close()
    }
})

test('version attendance observes one real active day at a time, caps at seven, and bulk claims only unclaimed configured dates', () => {
    const f = fixture()
    try {
        const before = f.tickets()
        f.advance(5 * 86400)
        f.login()
        assert.equal(f.sign().count, 2) // Offline days are not invented logins.
        f.call('ActivityVersionSign', { u32: 2002 })
        assert.equal(f.sign().reward_count, 2)
        assert.equal(f.tickets(), before + 2)
        for (let day = 3; day <= 7; day++) {
            f.advance(86400)
            f.login()
        }
        assert.equal(f.sign().count, 7)
        f.call('ActivityVersionSign', { u32: 2002 })
        assert.equal(f.sign().reward_count, 7)
        assert.equal(f.tickets(), before + 10)
        const completed = structuredClone(f.sign())
        f.advance(86400)
        f.login()
        assert.deepEqual(f.sign(), completed)
        assert.deepEqual(f.call('ActivityVersionSign', { u32: 2002 }).data.rewards, [])
        assert.equal(f.tickets(), before + 10)
    } finally {
        f.close()
    }
})

test('locked, closed, wrong-type and unknown version-sign requests cannot grant or mutate an earned balance', () => {
    const f = fixture({ unlocked: false })
    try {
        const player = f.state().player
        assert.throws(
            () => f.call('ActivityVersionSign', { u32: 2002 }),
            (error) => error.code === ErrorCode.ActivityNotOpen,
        )
        assert.throws(
            () => f.call('ActivityVersionSign', { u32: 2001 }),
            (error) => error.code === ErrorCode.ActivityTypeNotEqual,
        )
        assert.throws(
            () => f.call('ActivityVersionSign', { u32: 987654321 }),
            (error) => error.code === ErrorCode.ActivityNotFond,
        )
        assert.deepEqual(f.state().player, player)
        f.edit((s) => {
            s.taskRecords = [{ task_id: 106010, count: 1 }]
            s.tasks = []
        })
        f.login()
        f.call('ActivityVersionSign', { u32: 2002 })
        const earned = f.state().player,
            sign = structuredClone(f.sign())
        f.setNow(Date.UTC(2031, 0, 2) / 1000)
        assert.throws(
            () => f.call('ActivityVersionSign', { u32: 2002 }),
            (error) => error.code === ErrorCode.ActivityNotOpen,
        )
        assert.deepEqual(f.state().player, earned)
        assert.deepEqual(f.sign(), sign)
    } finally {
        f.close()
    }
})

test('version-sign reward or response failure rolls back grants and claim receipts; corrupt definitions do not become empty success', () => {
    const f = fixture()
    try {
        const request = f.frame('ActivityVersionSign', { u32: 2002 }),
            before = f.state(),
            encode = f.protocol.encode,
            response = f.protocol.byName.get('CSProtoActivityVersionSign').rsp
        f.protocol.encode = function (name, data) {
            if (name === response) throw Error('version-sign-response')
            return encode.call(this, name, data)
        }
        try {
            assert.throws(() => f.dispatch(request), /version-sign-response/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), before)
        f.dispatch(request)
        assert.equal(f.sign().reward_count, 1)
        assert.deepEqual(f.dispatch(request).data.rewards, [])
        const empty = {},
            row = f.tables.find('game_events', 2002),
            broken = {
                find: f.tables.find.bind(f.tables),
                get(name) {
                    return name === 'game_events_day_attendance_2d' ? [] : f.tables.get(name)
                },
            }
        assert.throws(
            () => versionSignSnapshot(broken, empty, row, 1800000000, (time) => f.game.activities.day(time)),
            (error) => error.code === ErrorCode.ActivityRewardConfNone,
        )
        assert.deepEqual(empty, {})
    } finally {
        f.close()
    }
    const bad = fixture({
        prepareTables(tables) {
            tables.cache.set(
                'game_events_day_attendance_2d',
                tables
                    .get('game_events_day_attendance_2d')
                    .map((row) => (row.date === 1 ? { ...row, reward: '3#999999999#1' } : row)),
            )
        },
    })
    try {
        const before = bad.state()
        assert.throws(() => bad.call('ActivityVersionSign', { u32: 2002 }))
        assert.deepEqual(bad.state(), before)
    } finally {
        bad.close()
    }
})
