import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards } from '../src/rewards.js'
import { playerTitleSnapshot } from '../src/player-titles.js'

const list = (f, session = f.a) => f.reply(f.call(session, 'TitleGetList'), 10300)
const select = (f, type, id, session = f.a) => f.call(session, 'TitleChange', { type, id })
const grant = (f, id, n = 1) =>
    f.call(f.a, 'GMCommand', { command: Buffer.from(`give 17 ${id} ${n}`).toString('base64') })
const available = (f, type) => f.tables.get('player_title').filter((row) => row.type === type)
const nondefault = (f, type) => available(f, type).find((row) => row.special !== 1).id
const synced = (f, packets) =>
    packets
        .filter((p) => p.id === f.protocol.byName.get('CSProtoSyncPlayerData').id)
        .map((p) => f.protocol.decode('cs.PlayerData', p.payload))

test('10300 exposes only table-configured defaults and 10301 changes the selected slot before ACK', () => {
    const f = chatShieldFixture('titles-default')
    try {
        assert.equal(f.tables.get('player_title').length, 22)
        assert.deepEqual(list(f), { preffix_title: [171000], suffix_title: [172000] })
        assert.equal(f.state(f.a).titles, undefined, 'query must not create ownership')
        const before = structuredClone(f.state(f.b)),
            packets = select(f, 1, 171000)
        const syncId = f.protocol.byName.get('CSProtoSyncPlayerData').id
        assert(packets.findIndex((p) => p.id === syncId) < packets.findIndex((p) => p.id === 10301))
        assert.equal(synced(f, packets)[0].basic_info.preffix_title, 171000)
        select(f, 2, 172000)
        assert.equal(f.state(f.a).player.basic_info.preffix_title, 171000)
        assert.equal(f.state(f.a).player.basic_info.suffix_title, 172000)
        assert.deepEqual(f.state(f.b), before)
        assert(!select(f, 1, 171000).some((p) => p.id === syncId), 'repeat selection has no duplicate changed data')
    } finally {
        f.store.close()
    }
})

test('resource type 17 grants real ownership through the shared reward path without unlocking the other account', () => {
    const f = chatShieldFixture('titles-grants')
    try {
        const pre = nondefault(f, 1),
            suffix = nondefault(f, 2),
            before = structuredClone(f.state(f.b))
        grant(f, pre)
        grant(f, suffix)
        assert(list(f).preffix_title.includes(pre))
        assert(list(f).suffix_title.includes(suffix))
        assert.deepEqual(list(f, f.b), { preffix_title: [171000], suffix_title: [172000] })
        select(f, 1, pre)
        select(f, 2, suffix)
        assert.equal(f.state(f.a).player.basic_info.preffix_title, pre)
        assert.equal(f.state(f.a).player.basic_info.suffix_title, suffix)
        grant(f, pre)
        assert.equal(list(f).preffix_title.filter((id) => id === pre).length, 1)
        assert.deepEqual(f.state(f.b), before)
        f.store.transact(f.a.id, 0, (state) => {
            for (const row of f.tables.get('player_title'))
                grantRewards(f.tables, state, [{ itemtype: 17, itemid: row.id, itemnum: 1 }])
        })
        const all = list(f)
        assert.equal(
            all.preffix_title.length + all.suffix_title.length,
            22,
            'all configured titles use the same grant path',
        )
    } finally {
        f.store.close()
    }
})

test('unknown, unowned and wrong-slot requests use exact title errors and roll back', () => {
    const f = chatShieldFixture('titles-errors')
    try {
        const before = structuredClone(f.state(f.a))
        for (const [type, id, code] of [
            [0, 171000, ErrorCode.TitleTypeFail],
            [3, 171000, ErrorCode.TitleTypeFail],
            [1, 172000, ErrorCode.TitleTypeFail],
            [2, 171000, ErrorCode.TitleTypeFail],
            [1, 0, ErrorCode.TitleConfNotExist],
            [1, 0xffffffff, ErrorCode.TitleConfNotExist],
            [1, nondefault(f, 1), ErrorCode.PlayerHadNotTheTitle],
        ]) {
            assert.throws(
                () => select(f, type, id),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(f.a), before)
        }
        assert.throws(
            () => grant(f, nondefault(f, 1), 2),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(f.a), before)
    } finally {
        f.store.close()
    }
})

test('damaged ownership and missing default table configuration are distinct from request errors', () => {
    const f = chatShieldFixture('titles-config')
    try {
        for (const titles of [
            [],
            { preffix_title: [172000] },
            { suffix_title: [172000, 172000] },
            { preffix_title: [-1] },
            { preffix_title: {} },
        ]) {
            f.store.transact(f.a.id, 0, (s) => {
                s.titles = titles
            })
            assert.throws(
                () => list(f),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
        f.store.transact(f.a.id, 0, (s) => {
            delete s.titles
        })
        const game = f.tables.get('game')
        f.tables.cache.set(
            'game',
            game.filter((row) => row.title !== 'PLAYERTITLE_DEFAULT'),
        )
        assert.throws(
            () => list(f),
            (e) => e.code === ErrorCode.GameConfig,
        )
        f.tables.cache.set(
            'game',
            game.map((row) => (row.title === 'PLAYERTITLE_DEFAULT' ? { ...row, value: '171000|999999' } : row)),
        )
        assert.throws(
            () => list(f),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('actual PlayerData or ACK codec failures roll back the selected title and granted ownership', () => {
    const f = chatShieldFixture('titles-codec'),
        encode = f.protocol.encode
    try {
        const pre = nondefault(f, 1)
        grant(f, pre)
        for (const type of ['cs.PlayerData', 'cs.ProtoNullRsp']) {
            const before = structuredClone(f.state(f.a)),
                token = f.store.readCacheToken(f.a.id)
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('title codec failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => select(f, 1, pre), /title codec failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.equal(f.store.readCacheToken(f.a.id), token)
            f.protocol.encode = encode
        }
        const before = structuredClone(f.state(f.a))
        const gmType = f.protocol.byName.get('CSProtoGMCommand').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === gmType) throw Error('title reward failed')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => grant(f, nondefault(f, 2)), /title reward failed/)
        assert.deepEqual(f.state(f.a), before)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('title ownership and selection survive real SQLite reopen and login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-player-titles-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = chatShieldFixture('titles-restart', file)
        const pre = nondefault(f, 1)
        grant(f, pre)
        select(f, 1, pre)
        select(f, 2, 172000)
        f.store.close()
        f = chatShieldFixture('titles-restart', file)
        assert(list(f).preffix_title.includes(pre))
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-titles-restart-a' })
        const login = f.reply(packets, f.protocol.byName.get('CSProtoEnterGame').id)
        assert.equal(login.data.basic_info.preffix_title, pre)
        assert.equal(login.data.basic_info.suffix_title, 172000)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-player-titles-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('repeated title list queries stay pure and use no full-profile load or SQLite writes', () => {
    const f = chatShieldFixture('titles-query')
    try {
        list(f)
        const before = f.store.db.prepare('SELECT total_changes() AS n').get().n,
            token = f.store.readCacheToken(f.a.id)
        f.store.load = () => {
            throw Error('must not clone profile')
        }
        f.store.read = () => {
            throw Error('warm title queries must use only the cached ownership projection')
        }
        for (let i = 0; i < 100; i++) assert.deepEqual(list(f), { preffix_title: [171000], suffix_title: [172000] })
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before)
        assert.equal(f.store.readCacheToken(f.a.id), token)
        const empty = {}
        assert.deepEqual(playerTitleSnapshot(f.tables, empty), { preffix_title: [171000], suffix_title: [172000] })
        assert.deepEqual(empty, {})
    } finally {
        f.store.close()
    }
})
