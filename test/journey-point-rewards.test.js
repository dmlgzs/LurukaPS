import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { journeyModel, journeyLedger, journeyPoints } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'

// A valid imported/future completed-target ledger exercises all current point
// tiers. It does not prove that the missing target event producers exist.
export function earnedJourneyPoints(f, minimum = 300) {
    f.store.transact(f.session.id, 0, (state) => {
        const model = journeyModel(f.tables),
            ledger = journeyLedger(state)
        for (const row of model.targets) {
            if (!model.owner.has(row.id)) continue
            ledger.targets[row.id] = { value: row.targetParam, complete: true, claimed: true }
            if (journeyPoints(model, state) >= minimum) break
        }
        assert.ok(journeyPoints(model, state) >= minimum)
    })
}
test('journey point reward uses achieved table tiers and a bitmask, leaving big reward separate', () => {
    const f = achievementFixture('journey-points-all')
    try {
        earnedJourneyPoints(f)
        const packets = f.call('JourneyReceivePointReward'),
            reply = f.reply(packets, 11882)
        assert.equal(
            reply.rewards.filter((r) => r.itemtype === 3 && r.itemid === 501000).reduce((s, r) => s + r.itemnum, 0),
            35,
        )
        assert.equal(f.state().journey.pointMask, 31)
        assert.equal(f.state().player.sbag_infos.items.find((r) => r.itemid === 501000).itemnum, 35)
        assert.equal(
            f.state().player.sbag_infos.items.some((r) => r.itemid === 1520901),
            false,
        )
        const sync = f.protocol.decode('SCJourneySync', packets.find((p) => p.id === 11880).payload)
        assert.equal(sync.reward_index, 31)
        assert.deepEqual(f.reply(f.call('JourneyReceivePointReward'), 11882).rewards, [])
        assert.equal(f.state().journey.pointMask, 31)
    } finally {
        f.store.close()
    }
})
test('journey point reward cannot be selected using forged empty-request fields or unearned points', () => {
    const f = achievementFixture('journey-points-unearned')
    try {
        assert.throws(() => f.call('JourneyReceivePointReward', { point_id: 6, points: 99999 }), /Unknown field/)
        assert.throws(
            () => f.call('JourneyReceivePointReward'),
            (e) => e.code === ErrorCode.JourneyNoReward,
        )
        assert.equal(f.state().journey.pointMask, 0)
        assert.equal(journeyPoints(journeyModel(f.tables), f.state()), 0)
    } finally {
        f.store.close()
    }
})
test('journey point reward rejects damaged masks and atomically rolls back a real codec failure', () => {
    const f = achievementFixture('journey-points-atomic')
    try {
        earnedJourneyPoints(f)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name === 'cs.Rewards' && value?.rewards?.length) throw Error('points codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('JourneyReceivePointReward'), /points codec/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.store.transact(f.session.id, 0, (s) => {
            s.journey.pointMask = 64
        })
        assert.throws(
            () => f.call('JourneyReceivePointReward'),
            (e) => e.code === ErrorCode.JourneyTypeDateError,
        )
    } finally {
        f.store.close()
    }
})
