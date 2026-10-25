import test from 'node:test'
import assert from 'node:assert/strict'
import { materialClearFixture } from './material-clear-fixture.js'
import { battlePassTaskModel, battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import { ErrorCode } from '../src/error-codes.js'
const ids = [1001203, 1001204],
    snapshot = (f) => battlePassTaskSnapshot(f.tables, f.state(), f.now()),
    task = (f, id) => snapshot(f).week_task.find((r) => r.task_id === id)
const ledger = (f) => prepareBattlePass(f.tables, f.state(), f.now()).ledger
test('both typed material weekly goals require five actual wins of their own tag and award configured season XP once', () => {
    const f = materialClearFixture('material-bp-single')
    try {
        assert(
            battlePassTaskModel(f.tables)
                .rows.filter((r) => r.kind === 15010)
                .every((r) => r.supported && !r.event),
        )
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: 1001203 }),
            (e) => e.code === ErrorCode.BattlePassTaskNotFinished,
        )
        f.edit((s) => (s.battlePass.seasons[s.battlePass.activeKey].tasks.week.counts[15010] = 999))
        f.call('ActivityGet')
        assert.equal(task(f, 1001203).curr_count, 0)
        assert.equal(task(f, 1001204).curr_count, 0)
        for (let i = 0; i < 5; i++) f.win(30101)
        assert.equal(task(f, 1001203).state, 1)
        assert.equal(task(f, 1001204).curr_count, 0)
        for (let i = 0; i < 5; i++) f.win(10101)
        assert.equal(task(f, 1001204).state, 1)
        const before = ledger(f).curr_week_exp,
            global = f.read((s) => s.player.attr_infos.attrs.find((a) => a.attr_id === 50)?.attr_val)
        for (const id of ids) {
            const entry = f.protocol.byName.get('CSProtoBattlePassGetTaskReward'),
                packets = f.call('BattlePassGetTaskReward', { task_id: id }),
                result = f.protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload)
            assert.equal(result.rewards[0].itemid, 50)
            assert.equal(result.rewards[0].itemnum, 600)
            assert.equal(task(f, id).state, 2)
            assert.deepEqual(
                f.protocol.decode(
                    entry.rsp,
                    f.call('BattlePassGetTaskReward', { task_id: id }).find((p) => p.id === entry.id).payload,
                ).rewards,
                [],
            )
        }
        assert.equal(ledger(f).curr_week_exp, before + 1200)
        assert.equal(
            f.read((s) => s.player.attr_infos.attrs.find((a) => a.attr_id === 50)?.attr_val),
            global,
        )
    } finally {
        f.close()
    }
})

test('material XP cap and real18002 sync/ACK/SQL failures preserve typed facts and consume reward receipts only once', () => {
    const f = materialClearFixture('material-bp-atomic')
    try {
        for (let i = 0; i < 5; i++) f.win(30101)
        const encode = f.protocol.encode
        for (const type of ['SCBattlePassBatchTaskSync', 'Rewards']) {
            const before = f.state()
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('material-bp-codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('BattlePassGetTaskReward', { task_id: 1001203 }), /material-bp-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        const before = f.state()
        f.store.db.exec(
            "CREATE TEMP TRIGGER material_bp_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'material-bp-SQL'); END",
        )
        try {
            assert.throws(() => f.call('BattlePassGetTaskReward', { task_id: 1001203 }), /material-bp-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER material_bp_abort')
        }
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.battlePass.seasons[s.battlePass.activeKey].curr_week_exp = 9950
        })
        const entry = f.protocol.byName.get('CSProtoBattlePassGetTaskReward'),
            packets = f.call('BattlePassGetTaskReward', { task_id: 1001203 })
        assert.equal(
            f.protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload).rewards[0].itemnum,
            50,
        )
        assert.equal(ledger(f).curr_week_exp, 10000)
        assert.equal(task(f, 1001203).state, 2)
        assert.equal(
            f.read((s) => s.materialDungeonRecords[30101].success_count),
            5,
        )
    } finally {
        f.close()
    }
})

test('weekly reset uses only new typed clears and malformed tuple keys cannot unlock material claims', () => {
    const f = materialClearFixture('material-bp-period')
    try {
        for (let i = 0; i < 5; i++) f.win(10101)
        const boundary = snapshot(f).weekEnd
        assert.equal(task(f, 1001204).state, 1)
        f.time(boundary + 1)
        f.call('ActivityGet')
        assert.equal(task(f, 1001204).curr_count, 0)
        assert.equal(
            f.read((s) => s.materialDungeonRecords[10101].success_count),
            5,
        )
        f.win(10101)
        assert.equal(task(f, 1001204).curr_count, 1)
        f.edit((s) => {
            s.battlePass.seasons[s.battlePass.activeKey].tasks.week.counts['material-clear:01:1:101'] = 9
        })
        const before = f.state()
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: 1001204 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
