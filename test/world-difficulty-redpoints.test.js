import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { worldDifficultyFixture } from './world-difficulty-fixture.js'
import { selectedWorldDifficulty } from '../src/world-difficulty-catalogue.js'
import { ErrorCode } from '../src/error-codes.js'

test('11402 persists per-map per-level read markers without selecting or unlocking that level', () => {
    const f = worldDifficultyFixture('difficulty-redpoints')
    try {
        f.unlock(100, 3)
        const selected = selectedWorldDifficulty(f.tables, f.state(), 100),
            world = structuredClone(f.state().world)
        const writes = f.store.db.prepare('select total_changes() n').get().n
        const packets = f.call('WorldDifficultyRedPointSet', { u32s: [100, 3, 1] })
        assert.equal(selectedWorldDifficulty(f.tables, f.state(), 100), selected)
        assert.deepEqual(f.state().worldDifficulties[100].redpoints, [3])
        assert.deepEqual(f.state().world, world)
        const i = packets.findIndex((p) => p.id === 11400)
        assert(i >= 0 && i < packets.findIndex((p) => p.id === 11402))
        const sync = f.protocol.decode('SCWorldDifficultyInfoSync', packets[i].payload)
        assert.equal(sync.send_type, 1)
        assert.deepEqual(sync.infos[0].redpoints_info, [{ difficulty: 3, redpoint: true }])
        f.call('WorldDifficultyRedPointSet', { u32s: [100, 3, 1] })
        assert.deepEqual(f.state().worldDifficulties[100].redpoints, [3])
        assert.deepEqual(f.state().worldDifficulties[101].redpoints, [])
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
    } finally {
        f.store.close()
    }
})

test('initial selected minima may be acknowledged before unlock, as the actual refreshSelected callback does', () => {
    const f = worldDifficultyFixture('difficulty-redpoint-minimum')
    try {
        const records = structuredClone(f.state().taskRecords)
        f.call('WorldDifficultyRedPointSet', { u32s: [101, 2, 1] })
        assert.deepEqual(f.state().worldDifficulties[101].redpoints, [2])
        assert.equal(selectedWorldDifficulty(f.tables, f.state(), 101), 2)
        assert.deepEqual(f.state().taskRecords, records)
        assert.throws(
            () => f.call('WorldDifficultyRedPointSet', { u32s: [101, 3, 1] }),
            (e) => e.code === ErrorCode.WorldDifficultyNotEnough,
        )
    } finally {
        f.store.close()
    }
})

test('malformed selectors, missing levels, unsupported reverse action and notification failure roll back read markers', () => {
    const f = worldDifficultyFixture('difficulty-redpoint-invalid'),
        encode = f.protocol.encode
    try {
        for (const [u32s, code] of [
            [[100, 1], ErrorCode.InvalidArgument],
            [[100, 1, 2], ErrorCode.InvalidArgument],
            [[100, 1, 0], ErrorCode.FunctionClosed],
            [[9999, 1, 1], ErrorCode.WorldDifficultyLevelNotExist],
        ]) {
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('WorldDifficultyRedPointSet', { u32s }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        for (const type of ['SCWorldDifficultyInfoSync', 'ProtoNullRsp']) {
            const shared = f.state(),
                before = structuredClone(shared)
            f.protocol.encode = function (name, ...args) {
                if (name === type || name === 'cs.' + type) throw Error('redpoint encoding failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('WorldDifficultyRedPointSet', { u32s: [100, 1, 1] }), /redpoint encoding failed/)
            assert.deepEqual(shared, before)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('WorldDifficultyRedPointSet', { u32s: [100, 1, 1] })
        assert.deepEqual(f.state().worldDifficulties[100].redpoints, [1])
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('read markers for two maps survive actual SQLite reopen and merged login without disturbing selected levels', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-difficulty-redpoints-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = worldDifficultyFixture('difficulty-redpoints-reopen', file)
        f.call('WorldDifficultyRedPointSet', { u32s: [100, 1, 1] })
        f.call('WorldDifficultyRedPointSet', { u32s: [101, 2, 1] })
        f.store.close()
        f = worldDifficultyFixture('difficulty-redpoints-reopen', file)
        assert.deepEqual(f.state().worldDifficulties[100].redpoints, [1])
        assert.deepEqual(f.state().worldDifficulties[101].redpoints, [2])
        const sync = f.protocol.decode('SCWorldDifficultyInfoSync', f.entryPackets.find((p) => p.id === 11400).payload)
        assert.equal(sync.send_type, 1)
        assert.deepEqual(
            sync.infos.map((r) => r.redpoints_info),
            [[{ difficulty: 1, redpoint: true }], [{ difficulty: 2, redpoint: true }]],
        )
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-difficulty-redpoints-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
