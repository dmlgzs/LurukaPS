import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { achievementFixture } from './achievement-fixture.js'
import { journeyModel, observeJourney } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'

function ready(f) {
    f.store.transact(f.session.id, 0, (s) => {
        s.player.heros_info.heros[0].hero_lv = 20
        s.pets[0].lv = 10
        ;(s.noviceCounters ??= {}).captures = 5
        s.taskRecords = [
            ...(s.taskRecords ?? []).filter((r) => r.task_id !== 106010),
            { task_id: 106010, count: 1, time: 1800000000 },
        ]
    })
}
const targetIds = [1010002, 1010003, 1010004, 1010005, 1010007]
function claimed(f) {
    return targetIds.filter((id) => f.state().journey.targets[id]?.claimed)
}
test('9869 task-ID batch collects five ready targets while two unsupported chapter targets remain incomplete', () => {
    const f = achievementFixture('journey-card-partial')
    try {
        ready(f)
        const packets = f.call('JourneyTaskFinish', { u32s: [20000] }),
            rewards = f.reply(packets, 9869).rewards
        assert.deepEqual(claimed(f), targetIds)
        assert.equal(
            rewards.filter((r) => r.itemtype === 3 && r.itemid === 501000).reduce((n, r) => n + r.itemnum, 0),
            3,
        )
        assert.equal(rewards.find((r) => r.itemtype === 3 && r.itemid === 1000007)?.itemnum, 10)
        assert(!rewards.some((r) => r.itemtype === 10 && r.itemid === 1))
        assert.equal(f.state().journey.targets[1010001]?.claimed ?? false, false)
        assert.equal(f.state().journey.targets[1010006]?.complete ?? false, false)
        assert.equal(f.state().journey.tasks[20000]?.claimed ?? false, false)
        const sync = f.protocol.decode('SCJourneySync', packets.find((p) => p.id === 11880).payload)
        assert.equal(sync.point_val, 25)
        assert.equal(sync.journey_task.find((r) => r.task_id === 20000).task_reward_status, 0)
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [20000] }), 9869).rewards, [])
    } finally {
        f.store.close()
    }
})
test('9869 task-ID and direct-target compatibility overlap never double-grants', () => {
    const f = achievementFixture('journey-card-overlap')
    try {
        ready(f)
        f.call('JourneyTaskFinish', { u32s: [20000, 1010002] })
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 501000)?.itemnum, 3)
        assert.equal(f.state().journey.claimRevision, 1)
    } finally {
        f.store.close()
    }
})
test('9869 task with no ready reward is safe and does not claim its parent reward', () => {
    const f = achievementFixture('journey-card-empty')
    try {
        const reply = f.reply(f.call('JourneyTaskFinish', { u32s: [20000] }), 9869)
        assert.deepEqual(reply.rewards, [])
        assert.equal(f.state().journey.tasks[20000]?.claimed ?? false, false)
    } finally {
        f.store.close()
    }
})
test('9869 aggregate rejects foreign, locked and malformed batches atomically', () => {
    const f = achievementFixture('journey-card-negative')
    try {
        ready(f)
        for (const [ids, code] of [
            [[20000, 999999], ErrorCode.JourneyConfError],
            [[20000, 20001], ErrorCode.JourneyTypeLock],
            [[20000, 20000], ErrorCode.InvalidArgument],
            [[20000, 1010006], ErrorCode.FunctionClosed],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('JourneyTaskFinish', { u32s: ids }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('9869 aggregate reward, inventory and journey sync encoding errors roll back all five claims', () => {
    for (const fail of [9869, 11880, 5008]) {
        const f = achievementFixture('journey-card-codec-' + fail),
            encode = f.protocol.encode.bind(f.protocol)
        try {
            ready(f)
            const before = f.state(),
                type = f.protocol.byId.get(fail).rsp
            f.protocol.encode = (name, value) => {
                if (name === type) throw Error('aggregate codec failure')
                return encode(name, value)
            }
            assert.throws(() => f.call('JourneyTaskFinish', { u32s: [20000] }), /aggregate codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
            f.call('JourneyTaskFinish', { u32s: [20000] })
            assert.deepEqual(claimed(f), targetIds)
        } finally {
            f.protocol.encode = encode
            f.store.close()
        }
    }
})
test('9869 only grants configured chapter reward once genuine completion receipts already exist', () => {
    const f = achievementFixture('journey-card-complete')
    try {
        ready(f)
        // Imported authoritative completion receipts test the settlement
        // contract only; they do not pretend missing 12235/13060 producers exist.
        f.store.transact(f.session.id, 0, (s) => {
            observeJourney(f.tables, s)
            for (const id of [1010001, 1010006]) s.journey.targets[id] = { value: 1, complete: true, claimed: true }
            s.journey.targetRevision++
        })
        const rewards = f.reply(f.call('JourneyTaskFinish', { u32s: [20000] }), 9869).rewards
        assert.equal(rewards.find((r) => r.itemtype === 10 && r.itemid === 1)?.itemnum, 100)
        assert.equal(rewards.find((r) => r.itemtype === 3 && r.itemid === 441001)?.itemnum, 5)
        assert.equal(f.state().journey.tasks[20000].claimed, true)
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [20000] }), 9869).rewards, [])
    } finally {
        f.store.close()
    }
})
test('9869 task aggregation persists target claims and point count across SQLite reopen', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'luruka-journey-card-')),
        file = path.join(dir, 'state.sqlite')
    let f
    try {
        f = achievementFixture('journey-card-persist', file)
        ready(f)
        f.call('JourneyTaskFinish', { u32s: [20000] })
        f.store.close()
        f = null
        f = achievementFixture('journey-card-persist', file)
        assert.deepEqual(claimed(f), targetIds)
        assert.equal(
            f.protocol.decode('SCJourneySync', f.entryPackets.find((p) => p.id === 11880).payload).point_val,
            25,
        )
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [20000] }), 9869).rewards, [])
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), path.resolve(tmpdir()))
        assert(path.basename(dir).startsWith('luruka-journey-card-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
