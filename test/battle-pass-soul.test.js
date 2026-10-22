import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import { ErrorCode } from '../src/error-codes.js'
const paid = (f, level = 30) =>
    f.store.transact(f.session.id, 0, (s) => {
        const { ledger } = prepareBattlePass(f.tables, s, 1800000000)
        ledger.pay_state = 1
        ledger.level = level
    })
test('battle pass self selection uses [level,9,soulID], grants a real instance and consumes only the paid-tier receipt once', () => {
    const f = achievementFixture('pass-soul')
    try {
        paid(f)
        const before = f.state().player.soulessence_infos.soulessences.length
        const packets = f.call('BattlePassSelectSoulEssence', { u32s: [30, 9, 10237] }),
            reply = f.reply(packets, 18011)
        assert.equal(reply.src, 135)
        assert.equal(reply.rewards.length, 1)
        assert(reply.rewards[0].guid)
        assert.equal(f.state().player.soulessence_infos.soulessences.length, before + 1)
        assert(
            f
                .state()
                .player.soulessence_infos.soulessences.some(
                    (x) => String(x.guid) === reply.rewards[0].guid && x.id === 10237,
                ),
        )
        const ledger = prepareBattlePass(f.tables, f.state(), 1800000000).ledger
        assert.deepEqual(ledger.paid, [30])
        assert.deepEqual(ledger.free, [])
        assert.deepEqual(f.reply(f.call('BattlePassSelectSoulEssence', { u32s: [30, 9, 10237] }), 18011).rewards, [])
        assert.throws(
            () => f.call('BattlePassSelectSoulEssence', { u32s: [30, 9, 10240] }),
            (e) => e.code === ErrorCode.BattlePassLevelAlreadyReceived,
        )
    } finally {
        f.store.close()
    }
})
test('battle pass self selection rejects unpaid, unreached, invalid type and options without granting a box or soul', () => {
    const f = achievementFixture('pass-soul-gates')
    try {
        assert.throws(
            () => f.call('BattlePassSelectSoulEssence', { u32s: [30, 9, 10237] }),
            (e) => e.code === ErrorCode.BattlePassNotPaid,
        )
        paid(f, 29)
        assert.throws(
            () => f.call('BattlePassSelectSoulEssence', { u32s: [30, 9, 10237] }),
            (e) => e.code === ErrorCode.BattlePassLevelExceeded,
        )
        paid(f)
        const before = f.state()
        assert.throws(
            () => f.call('BattlePassSelectSoulEssence', { u32s: [30, 3, 10237] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => f.call('BattlePassSelectSoulEssence', { u32s: [30, 9, 10061] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('battle pass soul reply failure rolls back instance allocation and selected receipt', () => {
    const f = achievementFixture('pass-soul-rollback')
    try {
        paid(f)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.Rewards' && value?.rewards?.length) throw Error('soul codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('BattlePassSelectSoulEssence', { u32s: [30, 9, 10237] }), /soul codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
