import { ErrorCode } from '../src/error-codes.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import { battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
import { recordActiveProgress } from '../src/daily-active.js'
const ready = (f) => {
    f.completedTask(106015)
    f.store.transact(f.session.id, 0, (s) => recordActiveProgress(f.tables, s, 13109, 1, 1800000000))
}
test('battle pass batch collects only completed tasks, aggregates season XP and remains once-only', () => {
    const f = achievementFixture('pass-task-batch')
    try {
        ready(f)
        const packets = f.call('BattlePassGetAllTaskReward'),
            reply = f.reply(packets, 18003),
            p = prepareBattlePass(f.tables, f.state(), 1800000000)
        assert.equal(reply.rewards.length, 1)
        assert.equal(reply.rewards[0].itemnum, 2500)
        assert.equal(p.ledger.level, 5)
        assert.equal(p.ledger.exp, 100)
        assert.equal(p.ledger.curr_week_exp, 500)
        assert.deepEqual(p.ledger.tasks.day.claimed, [1001101, 1001104])
        assert.deepEqual(p.ledger.tasks.forever.claimed, [1001301])
        assert.equal(packets.filter((p) => p.id === 18006).length, 1)
        assert.deepEqual(f.reply(f.call('BattlePassGetAllTaskReward'), 18003).rewards, [])
    } finally {
        f.store.close()
    }
})
test('battle pass task batch respects the weekly XP cap but still grants completed fixed tasks', () => {
    const f = achievementFixture('pass-task-batch-cap')
    try {
        ready(f)
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.curr_week_exp = 9950
        })
        assert.equal(f.reply(f.call('BattlePassGetAllTaskReward'), 18003).rewards[0].itemnum, 2050)
        const p = prepareBattlePass(f.tables, f.state(), 1800000000)
        assert.equal(p.ledger.curr_week_exp, 10000)
        assert.equal(p.ledger.level, 4)
        assert.equal(p.ledger.exp, 250)
        assert.deepEqual(p.ledger.tasks.day.claimed, [1001101, 1001104])
        assert.equal(
            battlePassTaskSnapshot(f.tables, f.state(), 1800000000).day_task.find((x) => x.task_id === 1001104).state,
            2,
        )
    } finally {
        f.store.close()
    }
})
test('battle pass task batch ignores unsupported or incomplete progress and rolls all state back if reply encoding fails', () => {
    const f = achievementFixture('pass-task-batch-rollback')
    try {
        ready(f)
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.tasks.week.counts[15010] = 99
        })
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.Rewards' && value?.rewards?.length) throw Error('all task codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('BattlePassGetAllTaskReward'), /all task codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('BattlePassGetAllTaskReward')
        const p = prepareBattlePass(f.tables, f.state(), 1800000000)
        assert(!p.ledger.tasks.week.claimed.includes(1001203))
        assert(!p.ledger.tasks.week.claimed.includes(1001204))
        assert(!p.ledger.tasks.week.claimed.includes(1001205))
    } finally {
        f.store.close()
    }
})

test('battle pass batch reaching maximum keeps settled XP and receipts while leaving later tasks untouched', () => {
    const f = achievementFixture('pass-task-batch-max-transition')
    try {
        ready(f)
        f.store.transact(f.session.id, 0, (s) => {
            const { ledger } = prepareBattlePass(f.tables, s, 1800000000)
            ledger.level = 69
            ledger.exp = 500
        })
        const reply = f.reply(f.call('BattlePassGetAllTaskReward'), 18003),
            p = prepareBattlePass(f.tables, f.state(), 1800000000)
        assert.equal(reply.rewards[0].itemnum, 300)
        assert.equal(p.ledger.level, 70)
        assert.equal(p.ledger.exp, 200)
        assert.deepEqual(p.ledger.tasks.day.claimed, [1001101])
        assert.deepEqual(p.ledger.tasks.forever.claimed, [])
    } finally {
        f.store.close()
    }
})
test('battle pass starting at maximum rejects pending task claims but a fully claimed replay remains empty and idempotent', () => {
    const f = achievementFixture('pass-task-batch-already-max')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.level = 70
        })
        const before = f.state()
        assert.throws(
            () => f.call('BattlePassGetAllTaskReward'),
            (e) => e.code === ErrorCode.BattlePassLevelExceeded,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.tasks.day.claimed = [1001101]
        })
        assert.deepEqual(f.reply(f.call('BattlePassGetAllTaskReward'), 18003).rewards, [])
    } finally {
        f.store.close()
    }
})
