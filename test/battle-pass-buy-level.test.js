import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import { buyBattlePassLevels } from '../src/battle-pass-buy-level.js'
import { ErrorCode } from '../src/error-codes.js'
test('battle pass purchases use count not target level, actual diamond cost, existing XP remainder and no premium entitlement', () => {
    const f = achievementFixture('pass-buy-level')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.diamond = 1000
            const { ledger } = prepareBattlePass(f.tables, s, 1800000000)
            ledger.exp = 499
            ledger.curr_week_exp = 600
        })
        const packets = f.call('BattlePassBuyLevel', { u32: 3 }),
            data = f.protocol.decode('SCBattlePassLevelExpPaySync', packets.find((p) => p.id === 18010).payload)
        assert.equal(data.level, 4)
        assert.equal(data.exp, 499)
        assert.equal(data.curr_week_exp, 600)
        assert.equal(data.pay_state, 0)
        assert.equal(f.state().player.basic_info.diamond, 550)
        assert(packets.findIndex((p) => p.id === 5008) >= 0)
    } finally {
        f.store.close()
    }
})
test('battle pass rejects insufficient diamonds, zero counts and exceeding final table level without modifying progress', () => {
    const f = achievementFixture('pass-buy-gates')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.diamond = 149
        })
        const before = f.state()
        assert.throws(
            () => f.call('BattlePassBuyLevel', { u32: 1 }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.throws(
            () => f.call('BattlePassBuyLevel', { u32: 0 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => f.call('BattlePassBuyLevel', { u32: 70 }),
            (e) => e.code === ErrorCode.BattlePassLevelExceeded,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('battle pass same transport purchase key is once-only and reply codec failure rolls back payment', () => {
    const f = achievementFixture('pass-buy-replay')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.diamond = 1000
        })
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.SCBattlePassLevelExpPaySync') throw Error('buy codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('BattlePassBuyLevel', { u32: 1 }), /buy codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        const state = structuredClone(before),
            c = { state, tables: f.tables, now: 1800000000, requestKey: 'test-session:18010:1', pushBefore: () => {} }
        buyBattlePassLevels(c, { u32: 2 })
        buyBattlePassLevels(c, { u32: 2 })
        assert.equal(state.player.basic_info.diamond, 700)
        assert.equal(prepareBattlePass(f.tables, state, c.now).ledger.level, 3)
        assert.throws(() => buyBattlePassLevels(c, { u32: 1 }), /sequence changed/)
    } finally {
        f.store.close()
    }
})
