import test from 'node:test'
import assert from 'node:assert/strict'
import { noviceEventFixture, noviceEventFile } from './novice-duel-event-fixture.js'
import { noviceNpcEventValue } from '../src/novice-duel-events.js'
import { NoviceTasks } from '../src/novice-tasks.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'

const wireTask = (packets, id) =>
    packets.flatMap((p) => (p.id === 10761 ? p.data.groups.flatMap((g) => g.tasks) : [])).find((r) => r.task_id === id)
const claim = (f, id) => f.call('NoviceTaskFinish', { u32: id }).find((p) => p.id === 10762).data
function unlock(f, groupId) {
    // Trusted old group receipts/quest gate are controlled preconditions;
    // the eight new event tasks and their facts are always earned live.
    f.edit((s) => {
        for (const group of [201, 202, 203, 204].filter((g) => g < groupId)) s.noviceTasks.claimedGroups[group] = true
        if (groupId > 201 && !(s.taskRecords ?? []).some((r) => r.task_id === 991002 && r.count > 0))
            (s.taskRecords ??= []).push({ task_id: 991002, count: 1 })
    })
}
function castTwiceAndDeploy(f, tag, skill) {
    f.selectTagged(tag)
    f.enterWithSkill(skill)
    f.cast(skill, '101')
    f.advance(3)
    const run = f.state().combat.npcDuel,
        first = f.actors().find((a) => run.in_fight[a.uuid]),
        second = f
            .actors()
            .find(
                (a) =>
                    a.uuid !== first.uuid &&
                    String(f.tables.find('pet', a.config_id).kiboDuelTag).split('|').map(Number).includes(tag),
            )
    assert(second)
    f.summon(second, first)
    const logic = f.tables.get('skillsub_logic').find((r) => r.skillId === skill)
    f.advance(Math.ceil(logic.kiBoVersusCoolDown / 1000) + 1)
    f.cast(skill, '102')
}

for (const [tag, skill, tagTask, skillTask, group] of [
    [101, 19999901, 5103, 5104, 201],
    [206, 19999902, 5203, 5204, 202],
    [202, 19999903, 5303, 5304, 203],
    [105, 19999904, 5402, 5403, 204],
]) {
    test(`real winning tag${tag} and skill${skill} facts complete and pay tasks${tagTask}/${skillTask} once`, () => {
        const f = noviceEventFixture('novice-eight-' + tag)
        try {
            unlock(f, group)
            castTwiceAndDeploy(f, tag, skill)
            assert.throws(
                () => claim(f, tagTask),
                (e) => e.code === ErrorCode.NoviceTaskNotFinished,
            )
            const won = f.win()
            for (const id of [tagTask, skillTask]) {
                assert.equal(wireTask(won, id).task_value, 1)
                assert.equal(wireTask(won, id).task_status, 1)
                assert(claim(f, id).rewards.length > 0)
                assert.deepEqual(claim(f, id).rewards, [])
            }
            assert.equal(
                new NoviceTasks(f.tables).value(f.state(), f.tables.find('novice_task', 5101)),
                1,
                'Existing13053 global wins coexist',
            )
            const saved = structuredClone(f.state().noviceDuelEventWins)
            f.relogin()
            assert.deepEqual(f.state().noviceDuelEventWins, saved)
            const system = new NoviceTasks(f.tables),
                closed = [...system.tasks.values()].filter(
                    (r) => r.id >= 5101 && [13054, 13057, 13058].includes(Number(r.finishCondition.split('#')[0])),
                )
            assert.equal(closed.length, 5)
            assert(closed.every((r) => system.value(f.state(), r) === null))
        } finally {
            f.close()
        }
    })
}

test('one deployed tag pet and one accepted cast cannot qualify as two; old terminal completion is retained without inventing events', () => {
    const f = noviceEventFixture('novice-eight-low')
    try {
        f.selectTagged(101)
        f.enterWithSkill(19999901)
        f.cast(19999901, '301')
        f.win()
        assert.equal(noviceNpcEventValue(f.state(), 13055, 101, 2), 0)
        assert.equal(noviceNpcEventValue(f.state(), 13056, 19999901, 2), 0)
        assert.throws(
            () => claim(f, 5103),
            (e) => e.code === ErrorCode.NoviceTaskNotFinished,
        )
        f.edit((s) => {
            s.noviceTasks.completedTasks[5103] = true
        })
        const saved = structuredClone(f.state().noviceDuelEventWins)
        assert(claim(f, 5103).rewards.length > 0, 'A trusted legacy completed receipt is not revoked')
        assert.deepEqual(f.state().noviceDuelEventWins, saved)
    } finally {
        f.close()
    }
})

for (const failure of ['codec', 'sql']) {
    test(`mixed tag/skill victory ${failure} failure rolls back both ledgers and novice sync before one durable retry`, () => {
        const temp = noviceEventFile(),
            f = noviceEventFixture('novice-eight-atomic-' + failure, { file: temp.file })
        let original
        try {
            castTwiceAndDeploy(f, 101, 19999901)
            f.prepareWin()()
            const before = structuredClone(f.state()),
                pending = f.store.pending.get(f.session.id),
                saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
            if (failure === 'codec') {
                original = f.game.packet
                f.game.packet = function (name, ...args) {
                    if (name === 'CSProtoNoviceTaskInfoSync') throw Error('eight-codec')
                    return original.call(this, name, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER eight_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'eight-sql'); END",
                )
            assert.throws(() => f.tick(), /eight-(codec|sql)/)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                saved,
            )
            if (failure === 'codec') f.game.packet = original
            else f.store.db.exec('DROP TRIGGER eight_fail')
            f.tick()
            assert.equal(noviceNpcEventValue(f.state(), 13055, 101, 2), 1)
            assert.equal(noviceNpcEventValue(f.state(), 13056, 19999901, 2), 1)
            const expected = structuredClone(f.state().noviceDuelEventWins),
                id = f.session.id
            f.call('KiboDuelBattleFinish', { status: 1 })
            assert.deepEqual(f.state().noviceDuelEventWins, expected)
            const reopened = new Store(temp.file)
            try {
                assert.deepEqual(reopened.load(id).state.noviceDuelEventWins, expected)
            } finally {
                reopened.close()
            }
        } finally {
            if (original) f.game.packet = original
            f.store.db.exec('DROP TRIGGER IF EXISTS eight_fail')
            try {
                f.close()
            } finally {
                temp.close()
            }
        }
    })
}
