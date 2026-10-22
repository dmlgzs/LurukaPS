import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { prepareBattlePass } from '../src/battle-pass.js'
const quantity = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
test('battle pass batch grants only reached free layers on an unpaid account and is idempotent', () => {
    const f = achievementFixture('pass-batch-free')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.level = 3
        })
        const before = f.state().player.basic_info.gold,
            paidBefore = quantity(f.state(), 400002),
            packets = f.call('BattlePassGetAllLevelReward')
        assert(f.reply(packets, 18004).rewards.length > 0)
        const ledger = prepareBattlePass(f.tables, f.state(), 1800000000).ledger
        assert.deepEqual(ledger.free, [1, 2, 3])
        assert.deepEqual(ledger.paid, [])
        assert.equal(f.state().player.basic_info.gold, before + 2000)
        assert.equal(quantity(f.state(), 400002), paidBefore)
        assert.deepEqual(f.reply(f.call('BattlePassGetAllLevelReward'), 18004).rewards, [])
        assert.equal(f.state().player.basic_info.gold, before + 2000)
    } finally {
        f.store.close()
    }
})
test('paid battle pass batch leaves the marked soul tier unclaimed while granting ordinary paid levels and free level30', () => {
    const f = achievementFixture('pass-batch-paid')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const { ledger } = prepareBattlePass(f.tables, s, 1800000000)
            ledger.level = 30
            ledger.pay_state = 1
        })
        const boxes = quantity(f.state(), 1520900),
            packets = f.call('BattlePassGetAllLevelReward'),
            ledger = prepareBattlePass(f.tables, f.state(), 1800000000).ledger
        assert.equal(ledger.free.length, 30)
        assert.equal(ledger.paid.length, 29)
        assert(!ledger.paid.includes(30))
        assert.equal(quantity(f.state(), 1520900), boxes)
        const sync = f.protocol.decode('SCBattlePassLevelRewardSync', packets.find((p) => p.id === 18007).payload)
        assert.deepEqual(sync.recved_pay_rewards, ledger.paid)
        assert.deepEqual(f.reply(f.call('BattlePassGetAllLevelReward'), 18004).rewards, [])
    } finally {
        f.store.close()
    }
})
test('refunded paid batch still permits free layers and a failed batch reply rolls back all grants and receipts', () => {
    const f = achievementFixture('pass-batch-refund')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const { ledger } = prepareBattlePass(f.tables, s, 1800000000)
            ledger.level = 2
            ledger.pay_state = 2
            ledger.is_refund = true
        })
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.Rewards' && value?.rewards?.length) throw Error('batch codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('BattlePassGetAllLevelReward'), /batch codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('BattlePassGetAllLevelReward')
        const ledger = prepareBattlePass(f.tables, f.state(), 1800000000).ledger
        assert.deepEqual(ledger.free, [1, 2])
        assert.deepEqual(ledger.paid, [])
    } finally {
        f.store.close()
    }
})
