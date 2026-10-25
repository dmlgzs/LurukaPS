import test from 'node:test'
import assert from 'node:assert/strict'
import { soulProgressFixture } from './pet-star-soul-progress-fixture.js'
import { journeyModel, journeyValue } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'

test('real11912 successor upgrades produce all eight15045 journey targets and stable unrelated requests do not republish', () => {
    const f = soulProgressFixture('pet-soul-journey-all', 3)
    try {
        const model = journeyModel(f.tables),
            rows = model.byKind.get(15045)
        assert.equal(rows.length, 8)
        assert(rows.every((row) => row.supported))
        assert(rows.every((row) => journeyValue(f.tables, f.state(), row) === 0))
        const first = f.advance(f.ids[0], 1, 2)
        assert(
            first.some((packet) => packet.id === 11880),
            'actual11912 petRevision wakes journey despite protocol name lacking Pet',
        )
        assert.equal(f.state().journey.targets[4060201].complete, true)
        assert.equal(f.state().journey.targets[4060202].complete, false)
        for (const id of f.ids) {
            f.advance(id, 6, 1)
            f.call('DelPet', { pet_list: [id] })
        }
        assert(rows.every((row) => f.state().journey.targets[row.id].complete))
        assert.equal(f.state().pets.length, 0)
        assert.equal(
            f.call('ActivityGet').some((packet) => packet.id === 11880),
            false,
        )
        assert.equal(
            f.call('ActivityGet').some((packet) => packet.id === 11880),
            false,
        )
    } finally {
        f.store.close()
    }
})

test('first current source-soul journey reward is atomic and idempotent while separate12042 system authority remains locked', () => {
    const f = soulProgressFixture('pet-soul-journey-claim', 2)
    try {
        for (const id of f.ids) f.advance(id, 2, 1)
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [60201] }),
            (error) => error.code === ErrorCode.JourneyTypeLock,
        )
        f.edit((state) => {
            // Isolate unrelated introductory journey prerequisites only.
            // No15045 progress or system5004 authorization is injected.
            state.journey.tasks[20000] = { complete: true, claimed: true }
            state.journey.claimRevision++
            state.player.basic_info.lv = 80
        })
        const encode = f.protocol.encode
        for (const type of ['SCJourneySync', 'Rewards']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('soul journey codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('JourneyTaskFinish', { u32s: [60201] }), /soul journey codec/)
                assert.deepEqual(f.state(), before)
            } finally {
                f.protocol.encode = encode
            }
        }
        assert(f.reply(f.call('JourneyTaskFinish', { u32s: [60201] }), 9869).rewards.length > 0)
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [60201] }), 9869).rewards, [])
        assert(f.state().journey.targets[4060202].complete)
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [60202] }),
            (error) => error.code === ErrorCode.JourneyTypeLock,
        )
        assert(!f.state().journey.tasks[60202]?.claimed)
    } finally {
        f.store.close()
    }
})
