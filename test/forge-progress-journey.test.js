import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { forgeFixture } from './forge-progress-fixture.js'
import { journeyModel, journeyValue, notifyJourney } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'

const ids = [2030406, 2030407]
const recipe = (f, difficulty) => f.tables.get('accessory_product').find((r) => r.difficulty === difficulty).id
const value = (f) => journeyValue(f.tables, f.state(), journeyModel(f.tables).byTarget.get(ids[1]))
function gates(f) {
    //Only unrelated tab prerequisite is supplied. Tested15072 targets and
    //30406/30407 completion/claim receipts must come from actual forge output.
    f.edit((s) => {
        s.player.basic_info.lv = 60
        s.journey.tasks[20000] = { complete: true, claimed: true }
        s.journey.claimRevision++
    })
}
function reply(f, packets, id) {
    const p = packets.find((p) => p.id === id)
    return f.protocol.decode(f.protocol.byId.get(id).res, p.payload)
}

test('full two15072 journey goals use difficultyIV actual claimed output and preserve owning-task gates and idempotence', () => {
    const f = forgeFixture('forge-journey-full')
    try {
        const model = journeyModel(f.tables),
            rows = model.targets.filter((r) => r.tokens[0] === 15072)
        assert.deepEqual(
            rows.map((r) => [r.id, r.targetParam]),
            [
                [ids[0], 1],
                [ids[1], 10],
            ],
        )
        assert(rows.every((r) => r.supported))
        assert.equal(model.targets.filter((r) => r.supported).length, 162)
        assert.equal(model.referencedTargets.filter((r) => r.supported).length, 146)
        assert.equal(model.referencedTargets.filter((r) => !r.supported).length, 149)
        f.make(recipe(f, 1), true)
        f.make(recipe(f, 4), false)
        assert.equal(value(f), 0)
        const accepted = f.start(recipe(f, 4), true, 4)
        assert.equal(value(f), 0)
        f.due([accepted.jobs[0]])
        f.game.tick(f.session.id)
        assert.equal(value(f), 0)
        f.finish(accepted.jobs)
        assert.equal(value(f), 1)
        assert.equal(f.state().journey.targets[ids[0]].complete, true)
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [30406] }),
            (e) => e.code === ErrorCode.JourneyTypeLock,
        )
        gates(f)
        //12096 tests completion of30406, not its reward claim. The next task
        //is now unlocked, but its10-piece target is still incomplete.
        assert.deepEqual(reply(f, f.call('JourneyTaskFinish', { u32s: [30407] }), 9869).rewards ?? [], [])
        f.call('JourneyTaskFinish', { u32s: [30406] })
        assert.equal(f.state().journey.targets[ids[0]].claimed, true)
        const beforeKeys = Object.keys(f.state().home.forgeProgress.counts)
        f.due(accepted.jobs)
        f.finish(accepted.jobs.slice(1), 'cancel')
        assert.equal(value(f), 4)
        assert.deepEqual(Object.keys(f.state().home.forgeProgress.counts), beforeKeys)
        f.make(recipe(f, 4), true, 4, 'aggregate')
        f.make(recipe(f, 4), true, 2, 'finish')
        assert.equal(value(f), 10)
        assert.equal(f.state().journey.targets[ids[1]].complete, true)
        f.call('JourneyTaskFinish', { u32s: [30407] })
        for (const task of [30406, 30407])
            assert.deepEqual(reply(f, f.call('JourneyTaskFinish', { u32s: [task] }), 9869).rewards ?? [], [])
        assert(ids.every((id) => f.state().journey.targets[id].claimed))
    } finally {
        f.store.close()
    }
})

test('claim and9869 sync/ACK or SQL failure roll back real source and both consumer state in the existing transaction', () => {
    const f = forgeFixture('forge-journey-rollback'),
        encode = f.protocol.encode
    try {
        gates(f)
        const accepted = f.start(recipe(f, 4))
        f.due(accepted.jobs)
        for (const type of ['SCJourneySync', 'SCProductFinish']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('forge journey codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.finish(accepted.jobs), /forge journey codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        const before = structuredClone(f.state())
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_forge_claim BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'forge SQL'); END",
        )
        try {
            assert.throws(() => f.finish(accepted.jobs), /forge SQL/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.store.db.exec('DROP TRIGGER fail_forge_claim')
        }
        f.finish(accepted.jobs)
        assert.equal(value(f), 1)
        for (const type of ['Rewards', 'SCJourneySync']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('forge journey reward codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('JourneyTaskFinish', { u32s: [30406] }), /forge journey reward codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('JourneyTaskFinish', { u32s: [30406] })
        assert(f.state().journey.targets[ids[0]].claimed)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('dedicated source revision catches deferred same-key history under unrelated callback and SQLite retains claims per account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-journey-'))
    let f
    try {
        const file = path.join(dir, 'test.sqlite')
        f = forgeFixture('forge-journey-persist', file)
        gates(f)
        f.make(recipe(f, 4))
        //Explicit stale-observer boundary using a fact already produced by10202
        //and6111, not synthetic completion or newly fabricated source history.
        let pushes = 0
        f.edit((s) => {
            s.journey.targets[ids[0]] = { value: 0, complete: false, claimed: false }
            s.journey.observedSources.forge--
            notifyJourney({ state: s, tables: f.tables, pushBefore: () => pushes++ }, 'CSProtoUnrelatedProbe')
        })
        assert.equal(pushes, 1)
        assert.equal(f.state().journey.targets[ids[0]].complete, true)
        f.edit((s) =>
            notifyJourney({ state: s, tables: f.tables, pushBefore: () => pushes++ }, 'CSProtoUnrelatedProbe'),
        )
        assert.equal(pushes, 1)
        f.call('JourneyTaskFinish', { u32s: [30406] })
        f.store.close()
        f = forgeFixture('forge-journey-persist', file)
        assert.equal(value(f), 1)
        assert(f.state().journey.targets[ids[0]].claimed)
        const other = {}
        f.call('EnterGame', { open_id: 'forge-journey-other' }, other)
        assert.equal(
            journeyValue(f.tables, f.store.load(other.id).state, journeyModel(f.tables).byTarget.get(ids[1])),
            0,
        )
    } finally {
        f?.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
        assert(path.basename(target).startsWith('forge-journey-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
