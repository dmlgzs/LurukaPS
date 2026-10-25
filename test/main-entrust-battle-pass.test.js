import test from 'node:test'
import assert from 'node:assert/strict'
import { mainEntrustFixture } from './main-entrust-clear-fixture.js'
import { battlePassTaskModel, battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
import { ErrorCode } from '../src/error-codes.js'
const snapshot = (f) => battlePassTaskSnapshot(f.tables, f.state(), f.now())
const task = (f) => snapshot(f).week_task.find((row) => row.task_id === 1001205)
const ledger = (f) => f.read((state) => structuredClone(state.battlePass.seasons[state.battlePass.activeKey]))

test('the complete current12251 weekly family counts real repeated main victories and claims configured XP once', () => {
    const f = mainEntrustFixture('main-clear-weekly-claim')
    try {
        const rows = battlePassTaskModel(f.tables).rows.filter((row) => row.kind === 12251)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].supported, true)
        f.edit((state) => {
            state.battlePass.seasons[state.battlePass.activeKey].tasks.week.counts[12251] = 999
        })
        assert.equal(task(f).curr_count, 0)
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: rows[0].id }),
            (error) => error.code === ErrorCode.BattlePassTaskNotFinished,
        )
        for (let index = 0; index < 4; index++) f.win(1)
        assert.equal(task(f).curr_count, 4)
        f.material.win(10101)
        assert.equal(task(f).curr_count, 4)
        f.win(1)
        assert.equal(task(f).curr_count, 5)
        assert.equal(task(f).state, 1)
        const previous = ledger(f).curr_week_exp
        f.call('BattlePassGetTaskReward', { task_id: rows[0].id })
        assert.equal(ledger(f).curr_week_exp - previous, 600)
        assert.equal(task(f).state, 2)
        f.call('BattlePassGetTaskReward', { task_id: rows[0].id })
        assert.equal(ledger(f).curr_week_exp - previous, 600)
        assert.equal(ledger(f).tasks.week.counts[12251], 999)
        assert.equal(ledger(f).tasks.week.counts['main-entrust-clear'], 5)
    } finally {
        f.close()
    }
})

test('12251 single claim keeps actual source on sync,ACK and SQLite failure and closes its receipt at the weekly cap', () => {
    const f = mainEntrustFixture('main-clear-weekly-atomic')
    try {
        for (let index = 0; index < 5; index++) f.win(1)
        f.call('ActivityGet')
        for (const type of ['SCBattlePassBatchTaskSync', 'Rewards']) {
            const before = f.state(),
                encode = f.protocol.encode
            f.protocol.encode = function (actual, ...args) {
                if (actual.replace(/^cs\./, '') === type) throw Error('main-bp-codec')
                return encode.call(this, actual, ...args)
            }
            try {
                assert.throws(() => f.call('BattlePassGetTaskReward', { task_id: 1001205 }), /main-bp-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        const before = f.state()
        f.store.db.exec(
            `CREATE TEMP TRIGGER main_bp_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.id()} BEGIN SELECT RAISE(ABORT,'main-bp-SQL'); END`,
        )
        try {
            assert.throws(() => f.call('BattlePassGetTaskReward', { task_id: 1001205 }), /main-bp-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER main_bp_abort')
        }
        assert.deepEqual(f.state(), before)
        f.edit((state) => {
            state.battlePass.seasons[state.battlePass.activeKey].curr_week_exp = 9950
        })
        f.call('BattlePassGetTaskReward', { task_id: 1001205 })
        assert.equal(ledger(f).curr_week_exp, 10000)
        assert.equal(task(f).state, 2)
        assert.equal(ledger(f).tasks.week.counts['main-entrust-clear'], 5)
        f.call('BattlePassGetTaskReward', { task_id: 1001205 })
        assert.equal(ledger(f).curr_week_exp, 10000)
    } finally {
        f.close()
    }
})

test('new week never projects old main achievements or previous weekly counts into12251', () => {
    const f = mainEntrustFixture('main-clear-new-week')
    try {
        for (let index = 0; index < 5; index++) f.win(1)
        assert.equal(task(f).state, 1)
        f.time(snapshot(f).weekEnd + 1)
        f.call('ActivityGet')
        assert.equal(task(f).curr_count, 0)
        assert.equal(task(f).state, 0)
        assert.equal(
            f.read((state) => state.entrust.records[1].entrust_id),
            1,
        )
        f.win(1)
        assert.equal(task(f).curr_count, 1)
    } finally {
        f.close()
    }
})
