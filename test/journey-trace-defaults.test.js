import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { achievementFixture } from './achievement-fixture.js'
import { setJourneyTrace } from '../src/journey-trace.js'
import { ErrorCode } from '../src/error-codes.js'

const sync = (f, packets) => f.protocol.decode('SCJourneySync', packets.find((packet) => packet.id === 11880).payload)

test('the exact logged four-byte request cancels its target with proto2 false omitted and grants nothing', () => {
    const f = achievementFixture('journey-trace-default-false')
    try {
        f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: true })
        const before = f.state(), request = { journey_id: 1010001 }
        const payload = f.protocol.encode('CSJourneyTrace', request)
        assert.equal(payload.toString('hex'), '08d1d23d')
        assert.equal(crypto.createHash('sha256').update(payload).digest('hex'), 'a35b856bac287c5da50cc91802d25e060eb60ef3a78c89265bfa3cd91eec5b48')
        assert.deepEqual(f.protocol.decode('CSJourneyTrace', payload), request)
        const packets = f.call('JourneyClientTrace', request)
        assert.equal(sync(f, packets).trace_id, 0)
        assert.deepEqual(f.protocol.decode('ProtoNullRsp', packets.find((packet) => packet.id === 11881).payload), {})
        const repeated = f.call('JourneyClientTrace', request)
        assert.ok(repeated.some((packet) => packet.id === 11881))
        assert.equal(f.state().journey.traceId, 0)
        const after = f.state()
        assert.deepEqual(after.player, before.player)
        assert.deepEqual(after.journey.targets, before.journey.targets)
        assert.equal(after.journey.claimRevision, before.journey.claimRevision)
    } finally { f.store.close() }
})

test('omitted false preserves newer traces; omitted zero identity follows explicit zero cancel semantics', () => {
    const f = achievementFixture('journey-trace-default-stale')
    try {
        f.call('JourneyClientTrace', { journey_id: 1010002, is_trace: true })
        for (const journey_id of [1010001, 99999999]) {
            const packets = f.call('JourneyClientTrace', { journey_id })
            assert.ok(packets.some((packet) => packet.id === 11881))
            assert.equal(f.state().journey.traceId, 1010002)
        }
        assert.equal(sync(f, f.call('JourneyClientTrace', {})).trace_id, 0)
        assert.throws(() => f.call('JourneyClientTrace', { is_trace: true }), (error) => error.code === ErrorCode.JourneyTraceTargetLock)
        assert.throws(() => f.call('JourneyClientTrace', { journey_id: 20000, is_trace: true }), (error) => error.code === ErrorCode.JourneyTraceTargetLock)
        assert.equal(f.state().journey.traceId, 0)
        for (const request of [{ journey_id: null }, { journey_id: '1010001' }, { journey_id: -1 }, { journey_id: 1010001, is_trace: null }, { journey_id: 1010001, is_trace: 0 }, { journey_id: 1010001, is_trace: 'false' }]) {
            const draft = structuredClone(f.state()), before = structuredClone(draft)
            assert.throws(() => setJourneyTrace({ tables: f.tables, state: draft }, request), (error) => error.code === ErrorCode.InvalidArgument)
            assert.deepEqual(draft, before)
        }
    } finally { f.store.close() }
})

test('an omitted-false cancellation rolls back if the real journey sync codec fails', () => {
    const f = achievementFixture('journey-trace-default-codec')
    try {
        f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: true })
        const before = f.state(), encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.SCJourneySync') throw Error('omitted-false trace sync codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('JourneyClientTrace', { journey_id: 1010001 }), /omitted-false trace sync codec/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        assert.equal(sync(f, f.call('JourneyClientTrace', { journey_id: 1010001 })).trace_id, 0)
    } finally { f.store.close() }
})

test('an omitted-false cancel persists across temporary SQLite reopen and does not cancel another account', async () => {
    const parent = path.dirname(fileURLToPath(import.meta.url)), dir = fs.mkdtempSync(path.join(parent, 'journey-default-relogin-'))
    let f
    try {
        const filename = path.join(dir, 'state.sqlite')
        f = achievementFixture('journey-default-persist-a', filename)
        f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: true })
        f.store.close(); f = undefined
        f = achievementFixture('journey-default-persist-b', filename)
        f.call('JourneyClientTrace', { journey_id: 1010002, is_trace: true })
        f.store.close(); f = undefined
        f = achievementFixture('journey-default-persist-a', filename)
        assert.equal(sync(f, f.entryPackets).trace_id, 1010001)
        f.call('JourneyClientTrace', { journey_id: 1010001 })
        f.store.close(); f = undefined
        f = achievementFixture('journey-default-persist-a', filename)
        assert.equal(sync(f, f.entryPackets).trace_id, 0)
        f.store.close(); f = undefined
        f = achievementFixture('journey-default-persist-b', filename)
        assert.equal(sync(f, f.entryPackets).trace_id, 1010002)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), parent)
        assert.ok(path.basename(dir).startsWith('journey-default-relogin-'))
        for (const name of fs.readdirSync(dir)) {
            assert.ok(/^state\.sqlite(?:-journal|-wal|-shm)?$/.test(name))
            for (let attempt = 0; ; attempt++) {
                try { fs.unlinkSync(path.join(dir, name)); break }
                catch (error) {
                    if (error.code !== 'EBUSY' || attempt >= 20) throw error
                    await new Promise((resolve) => setTimeout(resolve, 100))
                }
            }
        }
        fs.rmdirSync(dir)
    }
})
