import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { prepareBattlePass, battlePassSnapshot, battlePassModel, battlePassRow } from '../src/battle-pass.js'
const count = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
test('battle pass login publishes table season and initial level; free level reward really arrives once with source and level receipt', () => {
    const f = achievementFixture('battle-pass-free')
    try {
        const p = f.entryPackets.find((p) => p.id === 18000)
        assert(p)
        const sync = f.protocol.decode('SCBattlePassSync', p.payload)
        assert.equal(sync.info.battlepass_id, 1001)
        assert.equal(sync.info.level, 1)
        assert.equal(sync.info.pay_state, 0)
        assert(Number(sync.battlepass_end_time) > 1800000000)
        const before = count(f.state(), 400001),
            packets = f.call('BattlePassGetLevelReward', { level: 1, is_paid: false }),
            reply = f.reply(packets, 18001)
        assert.equal(reply.src, 132)
        assert.equal(count(f.state(), 400001), before + 2)
        const update = f.protocol.decode('SCBattlePassLevelRewardSync', packets.find((p) => p.id === 18007).payload)
        assert.deepEqual(update.recved_free_rewards, [1])
        assert.deepEqual(update.recved_pay_rewards, [])
        assert.deepEqual(f.reply(f.call('BattlePassGetLevelReward', { level: 1 }), 18001).rewards, [])
        assert.equal(count(f.state(), 400001), before + 2)
    } finally {
        f.store.close()
    }
})
test('unpaid, unreached and invalid battle pass claims use native errors and do not alter owned rewards', () => {
    const f = achievementFixture('battle-pass-gates')
    try {
        const before = f.state()
        assert.throws(
            () => f.call('BattlePassGetLevelReward', { level: 1, is_paid: true }),
            (e) => e.code === ErrorCode.BattlePassNotPaid,
        )
        assert.throws(
            () => f.call('BattlePassGetLevelReward', { level: 2 }),
            (e) => e.code === ErrorCode.BattlePassLevelExceeded,
        )
        assert.throws(
            () => f.call('BattlePassGetLevelReward', { level: 100101 }),
            (e) => e.code === ErrorCode.BattlePassLevelExceeded,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('trusted paid entitlement fixture may claim paid layer, while the marked soul tier requires selection and refund is denied', () => {
    const f = achievementFixture('battle-pass-paid')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            let { ledger } = prepareBattlePass(f.tables, s, 1800000000)
            ledger.pay_state = 1
            ledger.level = 30
        })
        const before = count(f.state(), 400002)
        assert.equal(f.reply(f.call('BattlePassGetLevelReward', { level: 1, is_paid: true }), 18001).src, 133)
        assert.equal(count(f.state(), 400002), before + 2)
        assert.throws(
            () => f.call('BattlePassGetLevelReward', { level: 30, is_paid: true }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.is_refund = true
        })
        assert.throws(
            () => f.call('BattlePassGetLevelReward', { level: 2, is_paid: true }),
            (e) => e.code === ErrorCode.BattlePassRefund,
        )
    } finally {
        f.store.close()
    }
})
test('battle pass claims roll back on codec failure and the same season ID with changed start cannot reuse former claims or premium', () => {
    const f = achievementFixture('battle-pass-rollback')
    try {
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.Rewards' && value?.rewards?.length) throw Error('pass codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('BattlePassGetLevelReward', { level: 1 }), /pass codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        const state = structuredClone(f.state()),
            old = prepareBattlePass(f.tables, state, 1800000000)
        old.ledger.pay_state = 2
        old.ledger.free = [1]
        const changed = Object.create(f.tables)
        changed.get = (name) =>
            name === 'battle_pass'
                ? f.tables.get(name).map((r) => ({ ...r, startTime: '20260602-040000' }))
                : f.tables.get(name)
        const fresh = prepareBattlePass(changed, state, 1800000000)
        assert.notEqual(fresh.key, old.key)
        assert.equal(fresh.ledger.pay_state, 0)
        assert.deepEqual(fresh.ledger.free, [])
        assert.equal(battlePassSnapshot(f.tables, state, 2000000000).info.battlepass_id, 0)
    } finally {
        f.store.close()
    }
})

test('fresh CBT table times override only known stale values and retain future external revisions', () => {
    const f = achievementFixture('battle-pass-time-correction')
    try {
        const season = battlePassModel(f.tables).seasons[0]
        assert.equal(season.row.startTime, '20260101-040000')
        assert.equal(season.row.endTime, '20261008-035959')
        assert.equal(
            battlePassRow('battle_pass_task', f.tables.find('battle_pass_task', 1001308)).showTime,
            '20260924-040000',
        )
        assert.equal(
            battlePassRow('battle_pass', { id: 1001, startTime: '20270101-040000' }).startTime,
            '20270101-040000',
        )
    } finally {
        f.store.close()
    }
})
