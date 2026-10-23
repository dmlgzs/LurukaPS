import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { repeatTaskSnapshot, observeRepeatStamina } from '../src/repeat-event.js'
import { activeCounterSample } from '../src/daily-active.js'
import { spendCurrency } from '../src/inventory.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function fixture(name, filename = ':memory:') {
    const f = ornamentFixture(name, { filename })
    f.store.transact(f.session.id, 0, (s) => {
        ;(s.taskRecords ??= []).push({ task_id: 106015, count: 1 })
        s.player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val = '500'
    })
    const spend = (amount) =>
        f.store.transact(f.session.id, 0, (s) => {
            const before = activeCounterSample(s)
            spendCurrency(s, 3, amount)
            observeRepeatStamina(
                {
                    state: s,
                    tables: f.tables,
                    activityCatalog: f.game.activities,
                    now: Math.floor(Date.now() / 1000),
                    pushBefore: () => {},
                },
                before,
            )
        })
    return { ...f, spend }
}
const count = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
test('10505 snapshot has all three actual activity tasks and never imports historical stamina into event progress', () => {
    const f = fixture('repeat-task-initial')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.noviceCounters = { staminaSpent: 10000, captures: 0 }
        })
        const snapshot = repeatTaskSnapshot(f.tables, f.state())
        assert.equal(snapshot.finished_task_data.length, 3)
        assert(snapshot.finished_task_data.every((x) => x.value === 0 && x.status === 0))
        assert.equal(f.state().repeatEvent, undefined)
        const packets = f.reload(),
            p = packets.find((x) => x.id === 10505)
        assert(p)
        assert.deepEqual(
            f.protocol.decode(f.protocol.byId.get(10505).rsp, p.payload).finished_task_data.map((x) => x.status),
            [0, 0, 0],
        )
    } finally {
        f.store.close()
    }
})
test('10507 empty real request claims only earned 11006 tasks once using common delivery and publishes completion before ACK', () => {
    const f = fixture('repeat-task-claim')
    try {
        const before = count(f.state(), 402000),
            experience = f.state().player.basic_info.exp
        f.spend(60)
        assert.equal(f.state().repeatEvent.events[10001].total_cost_stamina, 60)
        const packets = f.call('RepeatEventGetTaskReward', {}),
            ack = packets.findIndex((x) => x.id === 10507)
        const rewards = f.protocol.decode(f.protocol.byId.get(10507).rsp, packets[ack].payload).rewards
        assert.equal(rewards.find((x) => x.itemtype === 3 && x.itemid === 402000).itemnum, 3)
        assert.equal(count(f.state(), 402000), before + 3)
        assert.deepEqual(f.state().repeatEvent.events[10001].claimed_tasks, [1])
        assert(packets.findIndex((x) => x.id === 10504) < ack)
        const unchanged = count(f.state(), 402000)
        f.call('RepeatEventGetTaskReward', {})
        f.call('RepeatEventGetTaskReward', { u32s: [1] })
        f.reload()
        f.call('RepeatEventGetTaskReward', {})
        assert.equal(count(f.state(), 402000), unchanged)
        f.spend(100)
        f.call('RepeatEventGetTaskReward', {})
        assert.deepEqual(f.state().repeatEvent.events[10001].claimed_tasks, [1, 2])
        assert.equal(count(f.state(), 402000), before + 6)
        assert.equal(f.state().player.basic_info.exp, experience + 20)
        f.store.transact(f.session.id, 0, (s) => {
            s.storyCampaignClears = { ...s.storyCampaignClears, 3974: { count: 1 } }
        })
        f.call('RepeatEventGetTaskReward', {})
        assert.deepEqual(f.state().repeatEvent.events[10001].claimed_tasks, [1, 2, 3])
        assert.equal(count(f.state(), 402000), before + 9)
        assert.equal(f.state().player.basic_info.exp, experience + 30)
    } finally {
        f.store.close()
    }
})
test('explicit unfinished, invalid and duplicate task IDs reject before delivery and keep receipts unchanged', () => {
    const f = fixture('repeat-task-reject')
    try {
        for (const [r, code] of [
            [{ u32s: [1] }, ErrorCode.RepeatEventLevelTaskNotDone],
            [{ u32s: [999] }, ErrorCode.RepeatEventLevelTaskConfigError],
            [{ u32s: [1, 1] }, ErrorCode.RepeatEventLevelTaskConfigError],
        ]) {
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('RepeatEventGetTaskReward', r),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('inactive event and no-op events cannot advance the repeat stamina ledger', () => {
    const f = fixture('repeat-task-inactive')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords = []
        })
        f.spend(60)
        assert.equal(f.state().repeatEvent, undefined)
        f.store.transact(f.session.id, 0, (s) =>
            observeRepeatStamina(
                {
                    state: s,
                    tables: f.tables,
                    activityCatalog: f.game.activities,
                    now: Math.floor(Date.now() / 1000),
                    pushBefore: () => {},
                },
                activeCounterSample(s),
            ),
        )
        assert.equal(f.state().repeatEvent, undefined)
    } finally {
        f.store.close()
    }
})
test('10507 packet encoder failure rolls back inventory, currency and claim receipts before same request retries', () => {
    const f = fixture('repeat-task-rollback')
    try {
        f.spend(160)
        const before = structuredClone(f.state()),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === f.protocol.byId.get(10504).rsp) throw Error('wire failure')
            return encode(type, value)
        }
        assert.throws(() => f.call('RepeatEventGetTaskReward', {}), /wire failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('RepeatEventGetTaskReward', {})
        assert.deepEqual(f.state().repeatEvent.events[10001].claimed_tasks, [1, 2])
    } finally {
        f.store.close()
    }
})

test('10507 delivered rewards and receipts survive a complete SQLite close and reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-repeat-task-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture('repeat-task-sqlite', file)
    try {
        const start = count(f.state(), 402000)
        f.spend(60)
        f.call('RepeatEventGetTaskReward', {})
        assert.equal(count(f.state(), 402000), start + 3)
        f.store.close()
        f = fixture('repeat-task-sqlite', file)
        const packets = f.reload(),
            sync = packets.find((x) => x.id === 10505)
        assert.equal(
            f.protocol
                .decode(f.protocol.byId.get(10505).rsp, sync.payload)
                .finished_task_data.find((x) => x.task_id === 1).status,
            2,
        )
        f.call('RepeatEventGetTaskReward', {})
        assert.equal(count(f.state(), 402000), start + 3)
        assert.deepEqual(f.state().repeatEvent.events[10001].claimed_tasks, [1])
    } finally {
        f.store.close()
        fs.rmSync(file)
        fs.rmdirSync(dir)
    }
})
