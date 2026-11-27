import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { queryPlayerInfo } from '../src/query-player-info.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const entry = protocol.byName.get('CSProtoPlayerInfo')
assert.equal(entry.id, 5100)
const base64 = (s) => Buffer.from(String(s)).toString('base64')
function fixture(file = ':memory:') {
    const names = [`profile-current-${++fixture.counter}-a`, `profile-current-${fixture.counter}-b`]
    let store = new Store(file, { flushIntervalMs: 60000 }),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 }),
        sessions = [{}, {}],
        seq = 1
    const call = (who, name, value = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(sessions[who], {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, value) : Buffer.alloc(0),
        })
    }
    const enter = () => {
        for (const who of [0, 1]) call(who, 'EnterGame', { open_id: names[who] })
    }
    enter()
    const state = (who) => store.load(sessions[who].id).state
    const raw = () => JSON.stringify([store.load(sessions[0].id), store.load(sessions[1].id)])
    const sql = () =>
        JSON.stringify(store.db.prepare('SELECT account_id,state,revision FROM players ORDER BY account_id').all())
    const data = (packets) => protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload)
    return {
        names,
        call,
        state,
        raw,
        sql,
        data,
        id: (who) => sessions[who].id,
        get store() {
            return store
        },
        get game() {
            return game
        },
        query(who, request) {
            return data(call(who, 'PlayerInfo', request))
        },
        befriend() {
            call(0, 'OpFriend', { optype: 2, op: 1, id: sessions[1].id })
            call(1, 'OpFriend', { optype: 1, op: 1, id: sessions[0].id })
        },
        give(who, type, id, n) {
            call(who, 'GMCommand', { command: base64('give'), args: [type, id, n].map(base64) })
        },
        reopen() {
            store.close()
            store = new Store(file, { flushIntervalMs: 60000 })
            game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 })
            sessions = [{}, {}]
            enter()
        },
        close() {
            store.db.exec('PRAGMA query_only=OFF')
            store.close()
        },
    }
}
fixture.counter = 0
// Actual current friendManager.requestFriendInfo consumer rule, not Unity execution.
const visibleFriends = (existing, response) => {
    const ids = new Set(response.player_infos.map((x) => x.id))
    return existing.filter((id) => ids.has(id))
}

test('actual6231 application/acceptance followed by current5100 keeps both contacts and UID lookup returns the existing peer', () => {
    const f = fixture()
    try {
        f.befriend()
        const a = f.id(0),
            b = f.id(1)
        assert.deepEqual(f.state(0).friends, [b])
        assert.deepEqual(f.state(1).friends, [a])
        const one = f.query(0, { types: [0], player_ids: [b] }),
            two = f.query(1, { types: [0], player_ids: [a] })
        assert.deepEqual(visibleFriends(f.state(0).friends, one), [b])
        assert.deepEqual(visibleFriends(f.state(1).friends, two), [a])
        assert.equal(one.player_infos[0].name, f.state(1).player.basic_info.name)
        assert.equal(one.player_infos[0].lv, f.state(1).player.basic_info.lv)
        // Blacklist UI also needs the person's public name; a ban is not an invented profile-visibility restriction.
        f.call(0, 'OpFriend', { optype: 3, op: 1, id: b })
        assert.deepEqual(
            f.query(0, { types: [1], player_ids: [b] }).player_infos.map((x) => x.id),
            [b],
        )
    } finally {
        f.close()
    }
})

test('empty IDs preserve own basic query; complete known selector range cannot reveal peer account, wallet, task, payment or map fields', () => {
    const f = fixture()
    try {
        f.give(0, 10, 2, 41)
        f.give(1, 10, 2, 98765)
        f.store.transact(f.id(1), 0, (s) => {
            Object.assign(s.player.basic_info, {
                account: base64('private-account'),
                regtm: 1700000000,
                map_id: 100,
                platform_account_id: 'private-platform',
                platform_online_id: 'private-platform-online',
            })
            s.paymentOrders = { secret: 'private-order' }
            s.world.pos = { x: 123456, y: 789, z: 987654 }
        })
        const own = f.query(0, { types: [], player_ids: [] }).player_infos[0]
        assert.equal(own.id, f.id(0))
        assert.equal(own.gold, f.state(0).player.basic_info.gold)
        const root = protocol.root.lookupType(entry.rsp)
        for (const type of Array.from({ length: 18 }, (_, i) => i)) {
            const packets = f.call(0, 'PlayerInfo', { types: [type], player_ids: [f.id(1)] }),
                wire = root.decode(packets.find((p) => p.id === entry.id).payload).player_infos[0]
            assert.equal(wire.id, f.id(1))
            for (const key of [
                'account',
                'regtm',
                'gold',
                'diamond',
                'exp',
                'map_id',
                'team_id',
                'lock_system',
                'hero_gift_info',
                'platform_account_id',
                'platform_online_id',
                'active_door_scene',
            ])
                if (['lock_system', 'active_door_scene'].includes(key))
                    assert.equal(wire[key].length, 0, `peer selector${type} exposed ${key}`)
                else assert(!Object.hasOwn(wire, key), `peer selector${type} exposed ${key}`)
        }
        const mixed = f.query(0, { types: [0], player_ids: [f.id(1), 0xffffffff, f.id(1), f.id(0)] })
        assert.deepEqual(
            mixed.player_infos.map((x) => x.id),
            [f.id(1), f.id(0)],
        )
        assert.deepEqual(f.query(0, { types: [0], player_ids: [0xffffffff] }).player_infos, [])
    } finally {
        f.close()
    }
})

test('current100 raw-ID batch limit uses dedicated error; invalid selectors/UIDs and undeclared invitation contracts reject without state changes', () => {
    const f = fixture()
    try {
        assert.deepEqual(
            f.query(0, { types: [0], player_ids: Array(100).fill(f.id(1)) }).player_infos.map((x) => x.id),
            [f.id(1)],
        )
        for (const [request, code] of [
            [{ types: [0], player_ids: Array(101).fill(f.id(1)) }, ErrorCode.QueryPlayerTooMuch],
            [{ types: [99], player_ids: [f.id(1)] }, ErrorCode.InvalidArgument],
            [{ types: [0], player_ids: [0] }, ErrorCode.InvalidTarget],
            [{ types: [0], player_ids: [f.id(1)], qtype: 1 }, ErrorCode.FunctionClosed],
            [
                {
                    types: [0],
                    player_ids: [f.id(1)],
                    dungeon_query_list: [{ campaign_type: 2, dungeon_system_id: 30000 }],
                },
                ErrorCode.FunctionClosed,
            ],
        ]) {
            const before = f.raw(),
                sql = f.sql()
            assert.throws(
                () => f.call(0, 'PlayerInfo', request),
                (e) => e.code === code,
            )
            assert.equal(f.raw(), before)
            assert.equal(f.sql(), sql)
        }
        const c = { id: f.id(0), state: f.state(0) }
        for (const request of [
            { types: '0', player_ids: [] },
            { types: [], player_ids: '2' },
            { types: [], player_ids: [1.5] },
        ])
            assert.throws(
                () => queryPlayerInfo(c, request, f.store),
                (e) => e.code === ErrorCode.InvalidArgument || e.code === ErrorCode.InvalidTarget,
            )
    } finally {
        f.close()
    }
})

test('pending-peer projection is detached and SQL-readonly; steady concurrent Game queries do not repeat writes or flush the peer', async () => {
    const f = fixture()
    try {
        f.befriend()
        f.query(0, { types: [0], player_ids: [f.id(1)] })
        f.query(1, { types: [0], player_ids: [f.id(0)] })
        // Trusted Store pending-state seam, not a new social writer or asset grant.
        f.store.transact(
            f.id(1),
            0,
            (s) => {
                s.player.basic_info.sign = base64('pending-public-sign')
                s.player.basic_info.wardrobe = {
                    sex: 2,
                    parts: [{ type: 6, id: 606003, colors: [{ index: 0, color_id: 123456 }] }],
                }
            },
            { defer: true },
        )
        const peerSql = f.sql(),
            before = f.raw(),
            projected = queryPlayerInfo(
                { id: f.id(0), state: f.state(0) },
                { types: [0], player_ids: [f.id(1)] },
                f.store,
            )
        assert.equal(projected.player_infos[0].sign, base64('pending-public-sign'))
        projected.player_infos[0].wardrobe.parts[0].colors[0].color_id = 1
        assert.equal(f.state(1).player.basic_info.wardrobe.parts[0].colors[0].color_id, 123456)
        assert.equal(f.raw(), before)
        assert.equal(f.sql(), peerSql)
        f.store.db.exec('PRAGMA query_only=ON')
        const readonly = queryPlayerInfo(
            { id: f.id(0), state: f.state(0) },
            { types: [0], player_ids: [f.id(1)] },
            f.store,
        )
        assert.equal(readonly.player_infos[0].sign, base64('pending-public-sign'))
        assert.equal(f.sql(), peerSql)
        // Game's shared observer pipeline intentionally opens BEGIN IMMEDIATE.
        // Keep that contract and assert zero DML for stable public RPC reads.
        f.store.db.exec('PRAGMA query_only=OFF')
        const changes = f.store.db.prepare('SELECT total_changes() n').get().n
        const result = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                Promise.resolve().then(() => {
                    const who = i % 2,
                        peer = 1 - who
                    const r = f.query(who, { types: [0], player_ids: [f.id(peer)] })
                    assert.equal(r.player_infos[0].id, f.id(peer))
                    return r
                }),
            ),
        )
        assert.equal(result.length, 8)
        assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, changes)
        assert.equal(f.sql(), peerSql)
        assert.equal(f.raw(), before)
    } finally {
        f.close()
    }
})

test('response codec failure and bad stored peer identity preserve both accounts and pending drafts; typed deactivation does not erase friend assets', () => {
    const f = fixture()
    try {
        f.befriend()
        const before = f.raw(),
            sql = f.sql(),
            encode = protocol.encode
        protocol.encode = function (type, value) {
            if (type === entry.rsp) throw new Error('public profile codec boundary')
            return encode.call(this, type, value)
        }
        try {
            assert.throws(
                () => f.call(0, 'PlayerInfo', { types: [0], player_ids: [f.id(1)] }),
                /public profile codec boundary/,
            )
        } finally {
            protocol.encode = encode
        }
        assert.equal(f.raw(), before)
        assert.equal(f.sql(), sql)
        f.store.transact(f.id(1), 0, (s) => {
            s.player.basic_info.id = 999999
        })
        const malformed = f.raw(),
            malformedSql = f.sql()
        assert.throws(
            () => f.call(0, 'PlayerInfo', { types: [0], player_ids: [f.id(1)] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.equal(f.raw(), malformed)
        assert.equal(f.sql(), malformedSql)
        f.store.transact(f.id(1), 0, (s) => {
            s.player.basic_info.id = f.id(1)
            s.player.basic_info.deleted = true
        })
        const deleted = f.raw()
        assert.throws(
            () => f.call(0, 'PlayerInfo', { types: [0], player_ids: [f.id(1)] }),
            (e) => e.code === ErrorCode.TargetPlayerDeactivated,
        )
        assert.equal(f.raw(), deleted)
        assert.deepEqual(f.state(0).friends, [f.id(1)])
        assert.deepEqual(
            f.query(0, { types: [0], player_ids: [f.id(0), f.id(1)] }).player_infos.map((x) => x.id),
            [f.id(0)],
        )
    } finally {
        f.close()
    }
})

test('real friend relationship and public profile query survive SQLite close/newStore/newGame without schema, balance or contact loss', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-profile-query-')),
        f = fixture(path.join(dir, 'synthetic.sqlite'))
    try {
        f.befriend()
        f.give(1, 10, 2, 12345)
        const before = f.query(0, { types: [0], player_ids: [f.id(1)] }),
            assets = JSON.stringify(f.state(1).player.sbag_infos),
            gold = f.state(1).player.basic_info.gold
        f.reopen()
        assert.deepEqual(f.query(0, { types: [0], player_ids: [f.id(1)] }), before)
        assert.deepEqual(f.state(0).friends, [f.id(1)])
        assert.deepEqual(f.state(1).friends, [f.id(0)])
        assert.equal(JSON.stringify(f.state(1).player.sbag_infos), assets)
        assert.equal(f.state(1).player.basic_info.gold, gold)
    } finally {
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
