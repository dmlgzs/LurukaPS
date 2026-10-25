import test from 'node:test'
import assert from 'node:assert/strict'
import { materialClearFixture } from './material-clear-fixture.js'
import { journeyModel, journeyValue, journeyPoints } from '../src/journey.js'
import { materialClearValue } from '../src/material-clear-progress.js'
import { ErrorCode } from '../src/error-codes.js'
const family = (model) => model.targets.filter((r) => r.tokens[0] === 15010)
function gates(f) {
    const model = journeyModel(f.tables)
    // Only unrelated quest/card prerequisites are supplied; every tested15010
    // target and each material victory remain real protocol-produced facts.
    f.edit((s) => {
        s.taskRecords ??= []
        for (const row of model.targets)
            if (row.tokens[0] !== 15010)
                s.journey.targets[row.id] = { value: row.targetParam, complete: true, claimed: true }
        s.journey.tasks[20000] = { complete: true, claimed: true }
        s.journey.claimRevision++
        for (const task of [106012, 106015])
            if (!s.taskRecords.some((r) => r.task_id === task && r.count > 0))
                s.taskRecords.push({ task_id: task, count: 1, time: 1799999900 })
    })
}
test('all thirteen15010 journeys use real subclass and minimum-difficulty clears,then claim actual owning cards once', () => {
    const f = materialClearFixture('material-journey-full')
    try {
        const model = journeyModel(f.tables),
            rows = family(model)
        assert.equal(rows.length, 13)
        assert(rows.every((r) => r.supported))
        assert.equal(model.targets.filter((r) => r.supported).length, 175)
        assert.equal(model.referencedTargets.filter((r) => r.supported).length, 159)
        for (const id of [10101, 10201, 10301]) f.win(id)
        for (let diff = 1; diff <= 6; diff++) f.win(20100 + diff)
        for (let diff = 1; diff <= 5; diff++) f.win(30100 + diff)
        for (let n = 1; n < 20; n++) f.win(30105)
        f.call('ActivityGet')
        assert.equal(materialClearValue(f.tables, f.state(), [15010, 2, 2, 0, 0, 100]), 5)
        assert.equal(materialClearValue(f.tables, f.state(), [15010, 3, 3, 0, 0, 100]), 22)
        for (const row of rows) {
            assert.equal(journeyValue(f.tables, f.state(), row), row.targetParam)
            assert.equal(
                f.read((s) => s.journey.targets[row.id].complete),
                true,
            )
        }
        const owner = model.owner.get(5040118)
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [owner] }),
            (e) => e.code === ErrorCode.JourneyTypeLock,
        )
        gates(f)
        const beforePoints = journeyPoints(model, f.state()),
            owners = [...new Set(rows.map((r) => model.owner.get(r.id)))]
        f.call('JourneyTaskFinish', { u32s: owners })
        assert(rows.every((r) => f.read((s) => s.journey.targets[r.id].claimed)))
        assert.equal(
            journeyPoints(model, f.state()) - beforePoints,
            rows.reduce((n, r) => n + r.completePoint, 0),
        )
        const source = f.read((s) => structuredClone(s.materialDungeonRecords)),
            ledger = f.read((s) => structuredClone(s.journey))
        f.call('JourneyTaskFinish', { u32s: owners })
        assert.deepEqual(
            f.read((s) => s.materialDungeonRecords),
            source,
        )
        assert.deepEqual(
            f.read((s) => s.journey),
            ledger,
        )
    } finally {
        f.close()
    }
})

test('last-win revision refreshes after10705,stable callbacks do not resend,and9902-independent journey claims roll back atomically', () => {
    const f = materialClearFixture('material-journey-cache')
    try {
        const model = journeyModel(f.tables),
            sync = f.protocol.byName.get('SCProtoJourneySync').id
        f.win(10101)
        const first = f.call('ActivityGet')
        assert(first.some((p) => p.id === sync))
        assert(!f.call('ActivityGet').some((p) => p.id === sync))
        f.edit((s) => (s.journey.targets[5040118] = { value: 20, complete: false, claimed: false }))
        f.call('JourneyClientTrace', { journey_id: 0, is_trace: false })
        assert.equal(
            f.read((s) => s.journey.targets[5040118].value),
            0,
        )
        gates(f)
        const owner = model.owner.get(1320203),
            encode = f.protocol.encode
        for (const type of ['SCJourneySync', 'Rewards']) {
            const before = f.state()
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('material-journey-codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('JourneyTaskFinish', { u32s: [owner] }), /material-journey-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        const before = f.state()
        f.store.db.exec(
            "CREATE TEMP TRIGGER material_journey_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'material-journey-SQL'); END",
        )
        try {
            assert.throws(() => f.call('JourneyTaskFinish', { u32s: [owner] }), /material-journey-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER material_journey_abort')
        }
        assert.deepEqual(f.state(), before)
        f.call('JourneyTaskFinish', { u32s: [owner] })
        assert(f.read((s) => s.journey.targets[1320203].claimed))
        assert.equal(
            f.read((s) => s.materialDungeonRecords[10101].success_count),
            1,
        )
    } finally {
        f.close()
    }
})
