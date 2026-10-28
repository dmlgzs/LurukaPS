import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noviceDuelFixture } from './novice-duel-victory-fixture.js'
import { NoviceTasks } from '../src/novice-tasks.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'

function unlock(f) {
    // Explicit old group/story receipts are only prerequisites; no fever event
    // or target5404 completion is imported here.
    f.store.transact(f.session.id, 0, (state) => {
        for (const id of [201, 202, 203]) state.noviceTasks.claimedGroups[id] = true
        ;(state.taskRecords ??= []).push({ task_id: 991002, count: 1 })
    })
}
const claim = (f) => f.call('NoviceTaskFinish', { u32: 5404 }).find((packet) => packet.id === 10762).data
const earned = (f) => {
    f.enter(2001)
    f.prepareWin()()
    return f.tick()
}

test('actual later opposite HP report cannot replace the first accepted score terminal before tick settlement', () => {
    const f = noviceDuelFixture('novice-fever-opposite-late')
    try {
        f.enter(2001)
        f.call('ControlMapAI', { control_type: 1, status: 1 })
        const run = () => f.state().combat.npcDuel
        const self = Object.values(run().actors).find((actor) => actor.camp === 1 && run().in_fight[actor.uuid])
        const enemies = Object.values(run().actors).filter((actor) => actor.camp === 2)
        const first = enemies.find((actor) => run().in_fight[actor.uuid])
        const second = enemies.find((actor) => actor.uuid !== first.uuid)
        f.advance(4)
        f.call('PVEEnemySummonReq', {
            pet_guid: second.uuid,
            pos: run().positions.enemySummon.pos,
            angle: second.angle,
        })
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.scores = { 1: 125, 2: 125 }
        })
        const hit = (from, target) =>
            f.call('BattleInfoReduce', {
                uint64_dic: [from.uuid, target.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -target.max_hp } }],
            })
        hit(self, first)
        const terminal = structuredClone(run().scoreOutcome)
        assert.equal(terminal.result, 1)
        hit(second, self)
        assert.equal(
            f.state().combat.entities[self.uuid].hp,
            0,
            'Existing delayed-settlement HP acceptance is not rewritten by this source fix',
        )
        assert.deepEqual(run().scoreOutcome, terminal)
        assert.equal(run().scores[1], 125)
        f.tick()
        assert.equal(run().result.result, 1)
        assert.equal(run().noviceFeverReceipt.atMs, terminal.atMs)
    } finally {
        f.close()
    }
})

test('actual HP report arriving beyond end_at cannot change the earlier timeout score comparison', () => {
    const f = noviceDuelFixture('novice-fever-after-timeout')
    try {
        f.enter(2001)
        f.call('ControlMapAI', { control_type: 1, status: 1 })
        const run = () => f.state().combat.npcDuel
        const self = Object.values(run().actors).find((actor) => actor.camp === 1 && run().in_fight[actor.uuid])
        const enemy = Object.values(run().actors).find((actor) => actor.camp === 2 && run().in_fight[actor.uuid])
        f.advance(350)
        f.call('BattleInfoReduce', {
            uint64_dic: [enemy.uuid, self.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -self.max_hp } }],
        })
        assert.deepEqual(run().scores, { 1: 1000, 2: 1000 })
        f.tick()
        assert.equal(run().result.result, 3)
        assert.equal(run().result.reason, 2)
        assert.equal(run().noviceFeverReceipt.atMs, Math.round(run().end_at * 1000))
        assert.equal(f.state().noviceDuelFeverWins, undefined)
    } finally {
        f.close()
    }
})

test('real fever victory is global before group unlock, then5404 claims once while the other4 remain unsupported', () => {
    const f = noviceDuelFixture('novice-fever-task')
    try {
        const system = new NoviceTasks(f.tables)
        earned(f)
        assert.equal(f.state().noviceDuelFeverWins.count, 1)
        assert.equal(f.state().noviceTasks.completedTasks[5404], undefined)
        assert.throws(
            () => claim(f),
            (error) => error.code === ErrorCode.NoviceTaskLock,
        )
        unlock(f)
        const before = structuredClone(f.state().noviceDuelFeverWins)
        assert(claim(f).rewards.length > 0)
        assert.deepEqual(claim(f).rewards, [])
        f.relogin()
        assert.deepEqual(f.state().noviceDuelFeverWins, before)
        assert.equal(f.state().noviceTasks.claimedTasks[5404], true)
        const other = f.tables
            .get('novice_task')
            .filter((row) => [13054, 13057].includes(Number(row.finishCondition.split('#')[0])))
        assert.equal(other.length, 4)
        assert(other.every((row) => system.value(f.state(), row) === null))
        assert.equal(system.value(f.state(), { finishCondition: '13058#2', param: 2 }), null)
    } finally {
        f.close()
    }
})

for (const failure of ['codec', 'sql']) {
    test(`real5404 ${failure} claim failure restores bag, completion, source and pending before one durable retry`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novice-fever-')),
            file = path.join(dir, 'state.sqlite')
        let f, encode
        try {
            f = noviceDuelFixture('novice-fever-' + failure, { file })
            unlock(f)
            const packets = earned(f)
            const task = packets
                .flatMap((packet) => (packet.id === 10761 ? packet.data.groups.flatMap((group) => group.tasks) : []))
                .find((row) => row.task_id === 5404)
            assert.equal(task.task_status, 1)
            assert.equal(task.task_value, 1)
            f.store.transact(
                f.session.id,
                0,
                (state) => {
                    state.feverPending = true
                },
                { defer: true },
            )
            const pending = f.store.pending.get(f.session.id),
                before = structuredClone(f.state()),
                sql = () =>
                    f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                saved = sql()
            if (failure === 'codec') {
                encode = f.protocol.encode
                const schema = f.protocol.byName.get('CSProtoNoviceTaskFinish').rsp
                f.protocol.encode = function (name, ...args) {
                    if (name === schema) throw Error('fever-claim-codec')
                    return encode.call(this, name, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER fever_claim_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'fever-claim-sql'); END",
                )
            assert.throws(() => claim(f), /fever-claim-(codec|sql)/)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(sql(), saved)
            if (encode) f.protocol.encode = encode
            else f.store.db.exec('DROP TRIGGER fever_claim_fail')
            assert(claim(f).rewards.length > 0)
            assert.deepEqual(claim(f).rewards, [])
            const id = f.session.id,
                facts = structuredClone(f.state().noviceDuelFeverWins)
            f.close()
            const store = new Store(file)
            try {
                assert.equal(store.load(id).state.noviceTasks.claimedTasks[5404], true)
                assert.deepEqual(store.load(id).state.noviceDuelFeverWins, facts)
            } finally {
                store.close()
            }
        } finally {
            if (encode) f.protocol.encode = encode
            f?.close()
            const target = path.resolve(dir)
            assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
            assert(path.basename(target).startsWith('novice-fever-'))
            fs.rmSync(target, { recursive: true, force: true })
        }
    })
}
