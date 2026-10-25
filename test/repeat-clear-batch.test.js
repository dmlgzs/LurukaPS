import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { repeatClearFixture } from './repeat-clear-fixture.js'
import { battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
const ids = [1001204, 1001205, 1001309]
const snapshot = (f) => battlePassTaskSnapshot(f.tables, f.state(), f.now())
const ledger = (f) => f.read((state) => structuredClone(state.battlePass.seasons[state.battlePass.activeKey]))
const reply = (f, packets) => {
    const entry = f.protocol.byName.get('CSProtoBattlePassGetAllTaskReward')
    return f.protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload)
}
function finish(f) {
    f.unlockThrough(10106)
    for (let index = 0; index < 5; index++) f.otherWin('entrust', 1)
    for (let index = 0; index < 5; index++) f.otherWin('material', 10101)
    for (const row of [...snapshot(f).day_task, ...snapshot(f).week_task, ...snapshot(f).forever_task])
        if (row.state === 1 && !ids.includes(row.task_id)) f.call('BattlePassGetTaskReward', { task_id: row.task_id })
}

test('81000 fixed and main/material weekly tasks batch their actual wins with old receipts intact across SQLite reopen', () => {
    const scratch = fileURLToPath(new URL('../../scratch', import.meta.url))
    fs.mkdirSync(scratch, { recursive: true })
    const file = path.join(scratch, 'repeat-bp-batch-' + Date.now() + '.sqlite')
    let f = repeatClearFixture('repeat-bp-batch', file)
    try {
        finish(f)
        const previous = ledger(f).curr_week_exp,
            claimed = ledger(f).tasks.day.claimed
        assert.equal(reply(f, f.call('BattlePassGetAllTaskReward')).rewards[0].itemnum, 3200)
        assert.equal(ledger(f).curr_week_exp - previous, 1200)
        assert(
            ids.every(
                (id) =>
                    [...snapshot(f).week_task, ...snapshot(f).forever_task].find((row) => row.task_id === id).state ===
                    2,
            ),
        )
        assert.deepEqual(ledger(f).tasks.day.claimed, claimed)
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
        const at = f.now(),
            revision = f.read((state) => state.repeatClearRevision),
            counts = ledger(f).tasks.forever.counts
        f.close()
        f = repeatClearFixture('repeat-bp-batch', file, { now: at })
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
        assert.equal(
            f.read((state) => state.repeatClearRevision),
            revision,
        )
        assert.deepEqual(ledger(f).tasks.forever.counts, counts)
    } finally {
        f.close()
    }
})

test('mixed batch preserves all three typed sources on sync/ACK/SQL failure and caps only the weekly portion', () => {
    const f = repeatClearFixture('repeat-bp-batch-atomic')
    try {
        finish(f)
        const encode = f.protocol.encode
        for (const type of ['SCBattlePassBatchTaskSync', 'Rewards']) {
            const before = f.state()
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('repeat-batch-codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('BattlePassGetAllTaskReward'), /repeat-batch-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        const before = f.state()
        f.store.db.exec(
            `CREATE TEMP TRIGGER repeat_batch_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.id()} BEGIN SELECT RAISE(ABORT,'repeat-batch-SQL'); END`,
        )
        try {
            assert.throws(() => f.call('BattlePassGetAllTaskReward'), /repeat-batch-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER repeat_batch_abort')
        }
        assert.deepEqual(f.state(), before)
        f.edit((state) => {
            state.battlePass.seasons[state.battlePass.activeKey].curr_week_exp = 9950
        })
        assert.equal(reply(f, f.call('BattlePassGetAllTaskReward')).rewards[0].itemnum, 2050)
        assert.equal(ledger(f).curr_week_exp, 10000)
        assert(
            ids.every(
                (id) =>
                    [...snapshot(f).week_task, ...snapshot(f).forever_task].find((row) => row.task_id === id).state ===
                    2,
            ),
        )
        assert.deepEqual(reply(f, f.call('BattlePassGetAllTaskReward')).rewards, [])
    } finally {
        f.close()
    }
})
