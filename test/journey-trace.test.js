import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('journey trace uses target IDs and synchronizes set, replacement and stale cancel', () => {
    const f = achievementFixture('journey-trace')
    try {
        const packets = f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: true })
        assert.ok(packets.some((p) => p.id === 11881))
        assert.equal(f.protocol.decode('SCJourneySync', packets.find((p) => p.id === 11880).payload).trace_id, 1010001)
        assert.throws(
            () => f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: true }),
            (e) => e.code === ErrorCode.JourneyTraceIsSame,
        )
        f.call('JourneyClientTrace', { journey_id: 1010002, is_trace: true })
        f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: false })
        assert.equal(f.state().journey.traceId, 1010002)
        f.call('JourneyClientTrace', { journey_id: 1010002, is_trace: false })
        assert.equal(f.state().journey.traceId, 0)
        f.call('JourneyClientTrace', { journey_id: 0, is_trace: false })
        assert.equal(f.state().journey.traceId, 0)
    } finally {
        f.store.close()
    }
})
test('journey trace rejects unknown, unreferenced, locked and completed cards without modifying the trace', () => {
    const f = achievementFixture('journey-trace-validation')
    try {
        f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: true })
        for (const id of [20000, 99999999, 6042009, 1120002]) {
            assert.throws(
                () => f.call('JourneyClientTrace', { journey_id: id, is_trace: true }),
                (e) => e.code === ErrorCode.JourneyTraceTargetLock,
            )
            assert.equal(f.state().journey.traceId, 1010001)
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.journey.targets[1010002] = { value: 1, complete: true, claimed: false }
        })
        assert.throws(
            () => f.call('JourneyClientTrace', { journey_id: 1010002, is_trace: true }),
            (e) => e.code === ErrorCode.JourneyTraceTargetFinish,
        )
        assert.equal(f.state().journey.traceId, 1010001)
    } finally {
        f.store.close()
    }
})
test('journey trace is rolled back if the real sync codec fails', () => {
    const f = achievementFixture('journey-trace-codec')
    try {
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.SCJourneySync') throw Error('trace codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: true }), /trace codec/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
