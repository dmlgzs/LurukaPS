import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noviceDuelFixture } from './novice-duel-victory-fixture.js'
import { NoviceTasks } from '../src/novice-tasks.js'
import { ErrorCode } from '../src/error-codes.js'
import { Store } from '../src/store.js'

const row = (packets, id) =>
    packets.flatMap((p) => (p.id === 10761 ? p.data.groups.flatMap((g) => g.tasks) : [])).find((r) => r.task_id === id)
const claim = (f, id) => f.call('NoviceTaskFinish', { u32: id }).find((p) => p.id === 10762).data
function nextGroup(f, group) {
    // Controlled old receipts for the thirteen still unsupported tasks, not
    // newly earned events. The new 13053 task is always won and claimed live.
    f.store.transact(f.session.id, 0, (s) => {
        for (const task of f.tables
            .get('novice_task')
            .filter((t) => t.groupId === group && !t.finishCondition.startsWith('13053#')))
            s.noviceTasks.claimedTasks[task.id] = true
        if (!(s.taskRecords ?? []).some((r) => r.task_id === 991002 && r.count > 0))
            (s.taskRecords ??= []).push({ task_id: 991002, count: 1 })
    })
    const first = f.call('NoviceTaskFinishGroup', { u32: group }).find((p) => p.id === 10763).data
    assert(first.rewards.length > 0)
    assert.deepEqual(f.call('NoviceTaskFinishGroup', { u32: group }).find((p) => p.id === 10763).data.rewards, [])
}

test('all five actual thresholds follow shared global new-win facts through real task and group claims', () => {
    const f = noviceDuelFixture('novice-consumer-five')
    try {
        const system = new NoviceTasks(f.tables)
        const unsupported = [...system.tasks.values()].filter(
            (r) => r.id >= 5101 && !r.finishCondition.startsWith('13053#'),
        )
        assert.equal(unsupported.length, 13)
        assert(unsupported.every((r) => system.value(f.state(), r) === null))
        assert.equal(system.value(f.state(), { finishCondition: '13053#0#3#2', param: 2 }), null)
        assert.equal(system.value(f.state(), { finishCondition: '13053#1#2#2', param: 2 }), null)
        f.enter(1001)
        const first = f.win()
        assert.equal(row(first, 5101).task_status, 1)
        assert.equal(row(first, 5101).task_value, 1)
        assert(claim(f, 5101).rewards.length > 0)
        assert.deepEqual(claim(f, 5101).rewards, [])
        assert.throws(
            () => claim(f, 5103),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        f.call('MultiCampaignQuit')
        let stars = 0
        for (const [id, target, group] of [
            [5102, 2, 201],
            [5201, 4, 202],
            [5301, 6, 203],
            [5401, 8, 204],
        ]) {
            while (stars < target) {
                f.enter(2001)
                const win = f.win()
                stars++
                assert.equal(f.state().noviceDuelVictory.counts['1:3'], stars)
                assert.equal(row(win, id)?.task_status, stars === target ? 1 : 0)
                f.call('MultiCampaignQuit')
            }
            assert(claim(f, id).rewards.length > 0)
            if (group !== 204) nextGroup(f, group)
        }
        const snapshot = system.snapshot(f.state())
        for (const id of [5101, 5102, 5201, 5301, 5401])
            assert.equal(snapshot.groups.flatMap((g) => g.tasks).find((t) => t.task_id === id).task_status, 2)
        const before = structuredClone(f.state().noviceDuelVictory)
        f.relogin()
        assert.deepEqual(f.state().noviceDuelVictory, before)
        assert(unsupported.every((r) => system.value(f.state(), r) === null))
    } finally {
        f.close()
    }
})

for (const failure of ['codec', 'sql']) {
    test(`a real novice victory claim ${failure} failure rolls back source, completion, bag and SQL before one retry`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novice-claim-')),
            file = path.join(dir, 'state.sqlite'),
            f = noviceDuelFixture('novice-claim-' + failure, { file })
        let original
        try {
            f.enter(1001)
            f.win()
            const before = structuredClone(f.state()),
                pending = f.store.pending.get(f.session.id),
                saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
            if (failure === 'codec') {
                original = f.protocol.encode
                f.protocol.encode = function (name, ...args) {
                    if (name === f.protocol.byName.get('CSProtoNoviceTaskFinish').rsp) throw Error('novice-claim-codec')
                    return original.call(this, name, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER novice_claim_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'novice-claim-sql'); END",
                )
            assert.throws(() => claim(f, 5101), /novice-claim-(codec|sql)/)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                saved,
            )
            if (failure === 'codec') f.protocol.encode = original
            else f.store.db.exec('DROP TRIGGER novice_claim_fail')
            assert(claim(f, 5101).rewards.length > 0)
            const won = structuredClone(f.state().noviceDuelVictory)
            assert.deepEqual(claim(f, 5101).rewards, [])
            assert.deepEqual(f.state().noviceDuelVictory, won)
            const id = f.session.id
            f.close()
            const reopened = new Store(file)
            try {
                assert.equal(reopened.load(id).state.noviceTasks.claimedTasks[5101], true)
                assert.deepEqual(reopened.load(id).state.noviceDuelVictory, won)
            } finally {
                reopened.close()
            }
        } finally {
            if (original) f.protocol.encode = original
            f.close()
            const target = path.resolve(dir)
            assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
            assert(path.basename(target).startsWith('novice-claim-'))
            fs.rmSync(target, { recursive: true, force: true })
        }
    })
}
