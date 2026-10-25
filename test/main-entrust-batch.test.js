import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainEntrustFixture } from './main-entrust-clear-fixture.js'
import { battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
const ids = [1001204, 1001205]
const snapshot = (f) => battlePassTaskSnapshot(f.tables, f.state(), f.now())
const ledger = (f) => f.read((state) => structuredClone(state.battlePass.seasons[state.battlePass.activeKey]))
const reply = (f, packets) => {
    const entry = f.protocol.byName.get('CSProtoBattlePassGetAllTaskReward')
    return f.protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload)
}
function complete(f) {
    for (let index = 0; index < 5; index++) f.win(1)
    for (let index = 0; index < 5; index++) f.material.win(10101)
    for (const row of [...snapshot(f).day_task, ...snapshot(f).week_task, ...snapshot(f).forever_task])
        if (row.state === 1 && !ids.includes(row.task_id)) f.call('BattlePassGetTaskReward', { task_id: row.task_id })
}

test('18003 batches real main and material clears without replacing old scalar receipts and survives SQLite reopen', () => {
    const scratch = fileURLToPath(new URL('../../scratch', import.meta.url))
    fs.mkdirSync(scratch, { recursive: true })
    const file = path.join(scratch, 'main-bp-batch-' + Date.now() + '.sqlite')
    let f = mainEntrustFixture('main-bp-batch', file)
    try {
        complete(f)
        const previous = ledger(f).curr_week_exp,
            claimed = ledger(f).tasks.day.claimed
        assert.equal(reply(f, f.call('BattlePassGetAllTaskReward')).rewards[0].itemnum, 1200)
        assert.equal(ledger(f).curr_week_exp, previous + 1200)
        assert(ids.every((id) => ledger(f).tasks.week.claimed.includes(id)))
        assert.deepEqual(ledger(f).tasks.day.claimed, claimed)
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
        const at = f.now(),
            main = ledger(f).tasks.week.counts['main-entrust-clear'],
            material = f.read((state) => state.materialDungeonRecords[10101].success_count)
        f.close()
        f = mainEntrustFixture('main-bp-batch', file)
        f.time(at)
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
        assert.equal(ledger(f).tasks.week.counts['main-entrust-clear'], main)
        assert.equal(
            f.read((state) => state.materialDungeonRecords[10101].success_count),
            material,
        )
    } finally {
        f.close()
    }
})

test('main-plus-material batch rolls back all source and reward state on codec/SQL failure and respects the shared cap', () => {
    const f = mainEntrustFixture('main-bp-batch-atomic')
    try {
        complete(f)
        for (const type of ['SCBattlePassBatchTaskSync', 'Rewards']) {
            const before = f.state(),
                encode = f.protocol.encode
            f.protocol.encode = function (actual, ...args) {
                if (actual.replace(/^cs\./, '') === type) throw Error('main-batch-codec')
                return encode.call(this, actual, ...args)
            }
            try {
                assert.throws(() => f.call('BattlePassGetAllTaskReward'), /main-batch-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        const before = f.state()
        f.store.db.exec(
            `CREATE TEMP TRIGGER main_batch_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.id()} BEGIN SELECT RAISE(ABORT,'main-batch-SQL'); END`,
        )
        try {
            assert.throws(() => f.call('BattlePassGetAllTaskReward'), /main-batch-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER main_batch_abort')
        }
        assert.deepEqual(f.state(), before)
        f.edit((state) => {
            state.battlePass.seasons[state.battlePass.activeKey].curr_week_exp = 9950
        })
        assert.equal(reply(f, f.call('BattlePassGetAllTaskReward')).rewards[0].itemnum, 50)
        assert.equal(ledger(f).curr_week_exp, 10000)
        assert(ids.every((id) => ledger(f).tasks.week.claimed.includes(id)))
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
    } finally {
        f.close()
    }
})
