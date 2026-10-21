import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('9703 uses UP-hero acquisitions instead of total draws and persists once-only threshold receipts independently of stage claims', () => {
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
    const claim = () => {
        const packets = call('GachaUp', { u32: 1001 })
        assert.equal(packets.at(-1).id, 9703)
        return protocol.decode(protocol.byId.get(9703).rsp, packets.at(-1).payload)
    }
    try {
        call('EnterGame', { open_id: 'gacha-up' })
        call('GachaData')
        const diamond = state().player.basic_info.diamond
        store.transact(session.id, 0, (s) => {
            s.gacha.pools[1001].gacha_pool.pool_draw_count = 1000
        })
        assert.deepEqual(claim().rewards.rewards, [])
        assert.equal(state().player.basic_info.diamond, diamond)
        store.transact(session.id, 0, (s) => {
            s.gacha.pools[1001].gacha_pool.draw_up_hero_count = 2
        })
        const first = claim()
        assert.equal(first.rewards.src, 140)
        assert.equal(first.gachaPool.received_up_count, 2)
        assert.equal(first.gachaPool.received_stage_count, 0)
        assert.equal(state().player.basic_info.diamond, diamond + 300)
        assert.deepEqual(claim().rewards.rewards, [])
        call('EnterGame', { open_id: 'gacha-up' }, {})
        assert.deepEqual(claim().rewards.rewards, [])
        store.transact(session.id, 0, (s) => {
            s.gacha.pools[1001].gacha_pool.draw_up_hero_count = 3
        })
        const row = tables.get('gacha_up_reward').find((row) => row.upRewardId === 1 && row.upCount === 3),
            old = row.reward
        row.reward = '3#4294967295#1'
        const before = structuredClone(state())
        assert.throws(claim, (error) => error.code === ErrorCode.GameConfig)
        assert.deepEqual(state(), before)
        row.reward = old
        assert.equal(claim().gachaPool.received_up_count, 3)
        assert.equal(state().player.basic_info.diamond, diamond + 450)
        assert.deepEqual(claim().rewards.rewards, [])
        assert.throws(
            () => call('GachaUp', { u32: 2001 }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        store.transact(session.id, 0, (s) => {
            s.gacha.pools[1001].pity = [null]
        })
        assert.throws(claim, (error) => error.code === ErrorCode.GameConfig)
    } finally {
        store.close()
    }
})
