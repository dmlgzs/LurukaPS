import test from 'node:test'
import assert from 'node:assert/strict'
import { noviceSpeciesFixture } from './novice-duel-species-fixture.js'
import { noviceEventFile } from './novice-duel-event-fixture.js'
import { noviceDuelSpeciesRule, noviceDuelSpeciesValue } from '../src/novice-duel-species.js'
import { NoviceTasks } from '../src/novice-tasks.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'

const claim = (f, id) => f.call('NoviceTaskFinish', { u32: id }).find((packet) => packet.id === 10762).data
const earned = (f) => {
    f.choose()
    f.enter(2001)
    f.deploy()
    return f.win()
}
function unlockSecond(f) {
    // Other tutorial/story prerequisites only: never seed 5105/5205 or species facts.
    f.edit((state) => {
        state.noviceTasks.claimedGroups[201] = true
        ;(state.taskRecords ??= []).push({ task_id: 991002, count: 1 })
    })
}

test('both real13057 targets earn from eight deployed species, pay once and reopen without manufacturing the other two conditions', () => {
    const temp = noviceEventFile(),
        f = noviceSpeciesFixture('species-two-tasks', { file: temp.file })
    let closed = false
    try {
        const system = new NoviceTasks(f.tables)
        assert.equal(noviceDuelSpeciesRule([13057, 8, 1]), true)
        assert.equal(noviceDuelSpeciesRule([13057, 7, 1]), false)
        assert.equal(noviceDuelSpeciesRule([13057, 8, 2]), false)
        assert.equal(system.value(f.state(), f.tables.find('novice_task', 5105)), 0)
        assert.throws(
            () => claim(f, 5105),
            (error) => error.code === ErrorCode.NoviceTaskNotFinished,
        )
        const won = earned(f)
        const task = won
            .flatMap((packet) => (packet.id === 10761 ? packet.data.groups.flatMap((group) => group.tasks) : []))
            .find((row) => row.task_id === 5105)
        assert.equal(task.task_value, 1)
        assert.equal(task.task_status, 1)
        const ledger = structuredClone(f.state().noviceDuelSpeciesWins)
        assert(claim(f, 5105).rewards.length > 0)
        assert.deepEqual(claim(f, 5105).rewards, [])
        assert.throws(
            () => f.call('NoviceTaskFinishGroup', { u32: 201 }),
            (error) => error.code === ErrorCode.NoviceTaskGroupNotFinished,
        )
        assert.throws(
            () => claim(f, 5205),
            (error) => error.code === ErrorCode.NoviceTaskLock,
        )
        unlockSecond(f)
        assert(claim(f, 5205).rewards.length > 0)
        assert.deepEqual(claim(f, 5205).rewards, [])
        f.relogin()
        assert.deepEqual(f.state().noviceDuelSpeciesWins, ledger)
        const rows = f.tables.get('novice_task').filter((row) => row.id >= 5101)
        assert.equal(rows.filter((row) => system.value(f.state(), row) !== null).length, 16)
        const unknown = rows.filter((row) => system.value(f.state(), row) === null)
        assert.equal(unknown.length, 2)
        assert(unknown.every((row) => Number(row.finishCondition.split('#')[0]) === 13054))
        const id = f.session.id
        f.close()
        closed = true
        const reopened = new Store(temp.file)
        try {
            const state = reopened.load(id).state
            assert.deepEqual(state.noviceDuelSpeciesWins, ledger)
            assert.equal(state.noviceTasks.claimedTasks[5105], true)
            assert.equal(state.noviceTasks.claimedTasks[5205], true)
        } finally {
            reopened.close()
        }
    } finally {
        try {
            if (!closed) f.close()
        } finally {
            temp.close()
        }
    }
})

for (const failure of ['codec', 'sql'])
    test(`real species target claim ${failure} rolls back rewards, completion, receipts, pending and disk then pays once`, () => {
        const temp = noviceEventFile(),
            f = noviceSpeciesFixture('species-task-' + failure, { file: temp.file })
        let original
        try {
            earned(f)
            const before = structuredClone(f.state()),
                pending = f.store.pending.get(f.session.id),
                sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
            if (failure === 'codec') {
                original = f.protocol.encode
                f.protocol.encode = function (type, ...args) {
                    if (type === f.protocol.byName.get('CSProtoNoviceTaskFinish').rsp)
                        throw Error('species-claim-codec')
                    return original.call(this, type, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER species_claim_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'species-claim-sql'); END",
                )
            assert.throws(() => claim(f, 5105), /species-claim-(codec|sql)/)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                sql,
            )
            if (failure === 'codec') f.protocol.encode = original
            else f.store.db.exec('DROP TRIGGER species_claim_fail')
            assert(claim(f, 5105).rewards.length > 0)
            assert.deepEqual(claim(f, 5105).rewards, [])
            assert.equal(noviceDuelSpeciesValue(f.state(), 8), 1)
            assert.deepEqual(f.state().noviceDuelSpeciesWins, before.noviceDuelSpeciesWins)
        } finally {
            if (original) f.protocol.encode = original
            f.store.db.exec('DROP TRIGGER IF EXISTS species_claim_fail')
            try {
                f.close()
            } finally {
                temp.close()
            }
        }
    })
