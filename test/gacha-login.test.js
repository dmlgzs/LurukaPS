import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { gachaTables } from '../src/gacha-tables.js'

const config = configuration()
const protocol = new Protocol(config.base)
const tables = new Tables(config.tables)
const poolIds = gachaTables(tables)
    .get('gacha')
    .map((row) => row.gachaId)
function fixture(store = new Store(':memory:')) {
    const game = new Game(protocol, store, tables, { clock: () => 1790000000 })
    let sequence = 1
    const call = (session, name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, value) })
    }
    const enter = (openId) => {
        const session = {}
        const packets = call(session, 'EnterGame', { open_id: openId })
        return { session, packets }
    }
    const decode = (packets) => {
        const pushed = packets.filter((packet) => packet.id === 9700)
        assert.equal(pushed.length, 1, 'login must initialize the card pool cache before its first UI check')
        assert.equal(pushed[0].seq ?? 0, 0, 'initial9700 is a typed unsolicited push, not a synthetic request ACK')
        const times = protocol.byName.get('CSProtoSyncCommonTimeConf').id
        assert(packets.findIndex((packet) => packet.id === times) < packets.indexOf(pushed[0]))
        const value = protocol.decode('SCGetGachaInfo', pushed[0].payload)
        assert.deepEqual(
            value.gacha_pools.map((entry) => entry.gacha_pool.pool_id),
            poolIds,
        )
        return value
    }
    return { game, store, call, enter, decode }
}

test('first login initializes every real card pool before PageGacha.CheckPool without a prior9700 request', () => {
    const f = fixture()
    try {
        const { session, packets } = f.enter('gacha-first-login')
        const initial = f.decode(packets)
        for (const entry of initial.gacha_pools) {
            const row = gachaTables(tables).find('gacha', entry.gacha_pool.pool_id)
            assert.deepEqual(
                entry.pity.map((counter) => counter.pity_id),
                row.guaranteeId.split('|').map(Number),
            )
            assert.equal(entry.gacha_pool.pool_draw_count, 0)
        }
        const before = f.store.load(session.id).state
        const explicit = f.call(session, 'GachaData')
        assert.deepEqual(
            protocol.decode('SCGetGachaInfo', explicit.find((packet) => packet.id === 9700).payload),
            initial,
        )
        assert.deepEqual(f.store.load(session.id).state.player, before.player)
        assert.deepEqual(before.gacha.history, [])
        assert.equal(before.gacha.nextRecordId, '1')
    } finally {
        f.store.close()
    }
})

test('relogin preserves paid draw counters and pity while another account receives independent initial data', () => {
    const f = fixture()
    try {
        const first = f.enter('gacha-saved-login')
        f.decode(first.packets)
        f.store.transact(first.session.id, 0, (state) => {
            const entry = state.gacha.pools[poolIds[0]]
            entry.gacha_pool.pool_draw_count = 19
            entry.gacha_pool.last_gacha_time = '1790000000'
            entry.pity[0].pity_count = 7
        })
        const before = f.store.load(first.session.id).state
        const again = f.enter('gacha-saved-login')
        const value = f.decode(again.packets).gacha_pools.find((entry) => entry.gacha_pool.pool_id === poolIds[0])
        assert.equal(value.gacha_pool.pool_draw_count, 19)
        assert.equal(value.pity[0].pity_count, 7)
        assert.deepEqual(f.store.load(first.session.id).state.gacha.history, before.gacha.history)
        assert.equal(f.store.load(first.session.id).state.player.basic_info.diamond, before.player.basic_info.diamond)
        const other = f.enter('gacha-independent-login')
        assert(f.decode(other.packets).gacha_pools.every((entry) => entry.gacha_pool.pool_draw_count === 0))
    } finally {
        f.store.close()
    }
})

test('login card pool synchronization survives SQLite reopen without creating a draw or consuming a ticket', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gacha-login-b28-'))
    const database = path.join(directory, 'state.sqlite')
    let store
    try {
        store = new Store(database)
        const first = fixture(store)
        const entry = first.enter('gacha-reopen-login')
        first.decode(entry.packets)
        const before = store.load(entry.session.id).state
        store.close()
        store = new Store(database)
        const second = fixture(store)
        const reopened = second.enter('gacha-reopen-login')
        second.decode(reopened.packets)
        const after = store.load(reopened.session.id).state
        assert.deepEqual(after.gacha, before.gacha)
        assert.deepEqual(after.player.sbag_infos, before.player.sbag_infos)
        assert.equal(after.player.basic_info.diamond, before.player.basic_info.diamond)
    } finally {
        store?.close()
        assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()))
        assert(path.basename(directory).startsWith('gacha-login-b28-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('a9700 login codec failure rolls back pool initialization rather than saving a partial bootstrap', () => {
    const f = fixture()
    try {
        const entry = f.enter('gacha-login-rollback')
        f.store.transact(entry.session.id, 0, (state) => delete state.gacha)
        const before = f.store.load(entry.session.id).state
        const encode = protocol.encode
        protocol.encode = function (name, value) {
            if (name === 'cs.SCGetGachaInfo') throw Error('intentional login gacha codec failure')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.enter('gacha-login-rollback'), /intentional login gacha codec failure/)
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(f.store.load(entry.session.id).state, before)
        f.decode(f.enter('gacha-login-rollback').packets)
    } finally {
        f.store.close()
    }
})
