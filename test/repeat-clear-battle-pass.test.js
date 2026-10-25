import test from 'node:test'
import assert from 'node:assert/strict'
import { repeatClearFixture } from './repeat-clear-fixture.js'
import { battlePassTaskModel, battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
import { ErrorCode } from '../src/error-codes.js'
const id = 1001309,
    level = 10106,
    key = 'repeat-clear:10001:10106:1'
const snapshot = (f) => battlePassTaskSnapshot(f.tables, f.state(), f.now())
const task = (f) => snapshot(f).forever_task.find((row) => row.task_id === id)
const ledger = (f) => f.read((state) => structuredClone(state.battlePass.seasons[state.battlePass.activeKey]))
const reply = (f, packets) => {
    const entry = f.protocol.byName.get('CSProtoBattlePassGetTaskReward')
    return f.protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload)
}

test('the complete current81000 family earns fixed task XP from the actual target victory before first-pass or chest claims', () => {
    const f = repeatClearFixture('repeat-bp-current')
    try {
        const model = battlePassTaskModel(f.tables)
        assert.equal(model.rows.filter((row) => row.supported).length, model.rows.length)
        assert.equal(model.rows.filter((row) => row.kind === 81000).length, 1)
        f.edit((state) => {
            state.battlePass.seasons[state.battlePass.activeKey].tasks.forever.counts[81000] = 99
        })
        f.unlockThrough(level - 1)
        assert.equal(task(f).curr_count, 0)
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: id }),
            (error) => error.code === ErrorCode.BattlePassTaskNotFinished,
        )
        f.win(level)
        assert.equal(task(f).state, 1)
        assert.equal(
            f.read((state) => state.repeatEvent.levels['10001:10106'].public_data.frist_pass_reward_fetched ?? false),
            false,
        )
        const week = ledger(f).curr_week_exp,
            global = f.read((state) => state.player.attr_infos.attrs.find((row) => row.attr_id === 50)?.attr_val)
        assert.equal(reply(f, f.call('BattlePassGetTaskReward', { task_id: id })).rewards[0].itemnum, 2000)
        assert.equal(ledger(f).curr_week_exp, week)
        assert.equal(task(f).state, 2)
        assert.equal(
            f.read((state) => state.player.attr_infos.attrs.find((row) => row.attr_id === 50)?.attr_val),
            global,
        )
        assert.deepEqual(reply(f, f.call('BattlePassGetTaskReward', { task_id: id })).rewards, [])
        f.call('EndDungeonScene', { result: 3 })
        f.call('StaminaBoxGet', { box_id: f.chest().id, times: 3 })
        assert.equal(ledger(f).tasks.forever.counts[key], 1)
    } finally {
        f.close()
    }
})

test('fixed81000 claim rolls back on actual sync/Rewards encoding and SQL errors while the weekly cap does not consume fixed XP', () => {
    const f = repeatClearFixture('repeat-bp-atomic')
    try {
        f.unlockThrough(level)
        f.call('ActivityGet')
        const encode = f.protocol.encode
        for (const type of ['SCBattlePassBatchTaskSync', 'Rewards']) {
            const before = f.state()
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('repeat-bp-codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('BattlePassGetTaskReward', { task_id: id }), /repeat-bp-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        const before = f.state()
        f.store.db.exec(
            `CREATE TEMP TRIGGER repeat_bp_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.id()} BEGIN SELECT RAISE(ABORT,'repeat-bp-SQL'); END`,
        )
        try {
            assert.throws(() => f.call('BattlePassGetTaskReward', { task_id: id }), /repeat-bp-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER repeat_bp_abort')
        }
        assert.deepEqual(f.state(), before)
        f.edit((state) => {
            state.battlePass.seasons[state.battlePass.activeKey].curr_week_exp = 10000
        })
        assert.equal(reply(f, f.call('BattlePassGetTaskReward', { task_id: id })).rewards[0].itemnum, 2000)
        assert.equal(ledger(f).curr_week_exp, 10000)
        assert.equal(task(f).state, 2)
    } finally {
        f.close()
    }
})

test('forever repeat goal keeps its source and completion across weekly reset without acquiring new victories from observation', () => {
    const f = repeatClearFixture('repeat-bp-week')
    try {
        f.unlockThrough(level)
        const revision = f.read((state) => state.repeatClearRevision)
        f.time(snapshot(f).weekEnd + 1)
        f.call('ActivityGet')
        assert.equal(task(f).curr_count, 1)
        assert.equal(task(f).state, 1)
        assert.equal(
            f.read((state) => state.repeatClearRevision),
            revision,
        )
        assert.equal(reply(f, f.call('BattlePassGetTaskReward', { task_id: id })).rewards[0].itemnum, 2000)
        assert.equal(task(f).state, 2)
    } finally {
        f.close()
    }
})

test('unsupported future repeat selectors cannot auto-complete even after the real level is defeated', () => {
    const f = repeatClearFixture('repeat-bp-unknown-selector', ':memory:', {
        configureTables(tables) {
            tables.cache.set(
                'battle_pass_task',
                tables
                    .get('battle_pass_task')
                    .map((row) => (row.id === id ? { ...row, condition: '81000|10106|1|1' } : row)),
            )
        },
    })
    try {
        assert.equal(battlePassTaskModel(f.tables).rows.find((row) => row.id === id).supported, false)
        f.unlockThrough(level)
        assert.equal(task(f).curr_count, 0)
        assert.equal(task(f).state, 0)
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: id }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
    } finally {
        f.close()
    }
})

test('other legitimate single-normal levels and positive targets use the same generic81000 consumer', () => {
    const other = 10105
    const f = repeatClearFixture('repeat-bp-other-target', ':memory:', {
        configureTables(tables) {
            tables.cache.set(
                'battle_pass_task',
                tables
                    .get('battle_pass_task')
                    .map((row) => (row.id === id ? { ...row, condition: `81000|${other}|0|2`, param: 2 } : row)),
            )
        },
    })
    try {
        f.unlockThrough(other)
        assert.equal(task(f).curr_count, 1)
        assert.equal(task(f).state, 0)
        f.win(other)
        assert.equal(task(f).curr_count, 2)
        assert.equal(task(f).state, 1)
        assert.equal(reply(f, f.call('BattlePassGetTaskReward', { task_id: id })).rewards[0].itemnum, 2000)
    } finally {
        f.close()
    }
})
