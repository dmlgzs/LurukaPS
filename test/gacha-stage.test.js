import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('9702 grants only achieved unclaimed table stages, synchronizes currency before ACK and rolls back partial grant failure', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    const claim = () => call('GachaStep', { u32: 1001 })
    const decode = (packets) => protocol.decode(protocol.byId.get(9702).rsp, packets.at(-1).payload)
    try {
        call('EnterGame', { open_id: 'gacha-stage' })
        call('GachaData')
        const beforeDiamond = state().player.basic_info.diamond
        assert.deepEqual(decode(claim()).rewards.rewards, [])
        store.transact(session.id, 0, (s) => {
            s.gacha.pools[1001].gacha_pool.pool_draw_count = 19
        })
        const packets = claim(),
            first = decode(packets)
        assert.equal(first.rewards.src, 139)
        assert.equal(first.rewards.rewards[0].itemnum, 150)
        assert.equal(first.gachaPool.received_stage_count, 1)
        assert.equal(state().player.basic_info.diamond, beforeDiamond + 150)
        assert.ok(packets.slice(0, -1).some((p) => p.id === protocol.byName.get('CSProtoSyncPlayerData').id))
        assert.deepEqual(decode(claim()).rewards.rewards, [])
        call('EnterGame', { open_id: 'gacha-stage' }, {})
        assert.deepEqual(decode(claim()).rewards.rewards, [])
        store.transact(session.id, 0, (s) => {
            s.gacha.pools[1001].gacha_pool.pool_draw_count = 100
        })
        const row = tables.get('gacha_step').find((row) => row.stepId === 1 && row.stepStage === 3),
            original = row.reward
        row.reward = '3#4294967295#1'
        const before = structuredClone(state())
        assert.throws(claim, (error) => error.code === ErrorCode.GameConfig)
        assert.deepEqual(state(), before)
        row.reward = original
        assert.equal(decode(claim()).gachaPool.received_stage_count, 10)
        assert.equal(state().player.basic_info.diamond, beforeDiamond + 1500)
        assert.deepEqual(decode(claim()).rewards.rewards, [])
        assert.throws(
            () => call('GachaStep', { u32: 2001 }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => call('GachaStep', { u32: 0xffffffff }),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        store.close()
    }
})
