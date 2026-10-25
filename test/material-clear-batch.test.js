import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialClearFixture } from './material-clear-fixture.js'
import { battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
import { prepareBattlePass } from '../src/battle-pass.js'
const ids = [1001203, 1001204],
    snap = (f) => battlePassTaskSnapshot(f.tables, f.state(), f.now()),
    bp = (f) => prepareBattlePass(f.tables, f.state(), f.now()).ledger
function finish(f) {
    for (let i = 0; i < 5; i++) f.win(30101)
    for (let i = 0; i < 5; i++) f.win(10101)
    for (const row of [...snap(f).day_task, ...snap(f).week_task, ...snap(f).forever_task])
        if (row.state === 1 && !ids.includes(row.task_id)) f.call('BattlePassGetTaskReward', { task_id: row.task_id })
}
function reply(f, packets) {
    const e = f.protocol.byName.get('CSProtoBattlePassGetAllTaskReward')
    return f.protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload)
}
test('18003 actual batch claims both material tags once,keeps prior scalar claims and persists through Store reopen', () => {
    const scratch = fileURLToPath(new URL('../../scratch', import.meta.url))
    fs.mkdirSync(scratch, { recursive: true })
    const file = path.join(scratch, 'material-bp-batch-' + Date.now() + '.sqlite')
    let f = materialClearFixture('material-bp-batch', file)
    try {
        finish(f)
        assert(ids.every((id) => snap(f).week_task.find((r) => r.task_id === id).state === 1))
        const before = bp(f).curr_week_exp,
            oldDay = [...bp(f).tasks.day.claimed]
        assert.equal(reply(f, f.call('BattlePassGetAllTaskReward')).rewards[0].itemnum, 1200)
        assert.equal(bp(f).curr_week_exp, before + 1200)
        assert(ids.every((id) => bp(f).tasks.week.claimed.includes(id)))
        assert.deepEqual(bp(f).tasks.day.claimed, oldDay)
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
        const time = f.now(),
            records = f.read((s) => structuredClone(s.materialDungeonRecords))
        f.close()
        f = materialClearFixture('material-bp-batch', file)
        f.time(time)
        assert(ids.every((id) => bp(f).tasks.week.claimed.includes(id)))
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
        assert.deepEqual(
            f.read((s) => s.materialDungeonRecords),
            records,
        )
    } finally {
        f.close()
    }
})
test('18003 batch sync/ACK and SQL failures roll back all material claims and the weekly cap still closes both receipts', () => {
    const f = materialClearFixture('material-bp-batch-rollback')
    try {
        finish(f)
        const encode = f.protocol.encode
        for (const type of ['SCBattlePassBatchTaskSync', 'Rewards']) {
            const before = f.state()
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('material-bp-batch-codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('BattlePassGetAllTaskReward'), /material-bp-batch-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        const before = f.state()
        f.store.db.exec(
            "CREATE TEMP TRIGGER material_batch_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'material-batch-SQL'); END",
        )
        try {
            assert.throws(() => f.call('BattlePassGetAllTaskReward'), /material-batch-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER material_batch_abort')
        }
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.battlePass.seasons[s.battlePass.activeKey].curr_week_exp = 9950
        })
        assert.equal(reply(f, f.call('BattlePassGetAllTaskReward')).rewards[0].itemnum, 50)
        assert.equal(bp(f).curr_week_exp, 10000)
        assert(ids.every((id) => bp(f).tasks.week.claimed.includes(id)))
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
    } finally {
        f.close()
    }
})
