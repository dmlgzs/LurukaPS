import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { heroRankProgressFixture } from './hero-rank-progress-fixture.js'
import { journeyModel, journeyValue, journeySnapshot, notifyJourney } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'

test('all eight current rank journey targets compile and rankII means actual permanent rank2', () => {
    const f = heroRankProgressFixture('rank-journey-family')
    try {
        const model = journeyModel(f.tables),
            rows = model.byKind.get(12055)
        assert.equal(rows.length, 8)
        assert(rows.every((row) => row.supported))
        assert.equal(model.targets.filter((row) => row.supported).length, 153)
        assert.equal(model.referencedTargets.filter((row) => row.supported).length, 137)
        const adapter = Object.create(f.tables)
        adapter.get = (name) =>
            name === 'journey_task_target'
                ? f.tables
                      .get(name)
                      .map((row) => (row.id === rows[0].id ? { ...row, condition: '12055|2|2', targetParam: 1 } : row))
                : f.tables.get(name)
        assert.equal(journeyModel(adapter).byTarget.get(rows[0].id).supported, false)
        assert(rows.every((row) => journeyValue(f.tables, f.state(), row) === 0))
        const hero = f.state().player.heros_info.heros[0]
        const packets = f.advance(hero.guid, 2)
        assert.equal(f.state().journey.targets[1320201].value, 1)
        assert.equal(f.state().journey.targets[1320201].complete, true)
        assert.equal(f.state().journey.targets[4050301].complete, false)
        const packet = packets.find((row) => row.id === 11880)
        assert(packet)
        assert.equal(
            f.protocol.decode('SCJourneySync', packet.payload).journey_target.find((row) => row.target_id === 1320201)
                .target_reward_status,
            1,
        )
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [1320201] }),
            (error) => error.code === ErrorCode.JourneyTypeLock,
        )
    } finally {
        f.store.close()
    }
})

test('actual rank progression completes every family threshold while existing commission and tab gates remain enforced', () => {
    const f = heroRankProgressFixture('rank-journey-all')
    try {
        const model = journeyModel(f.tables),
            rows = model.byKind.get(12055)
        for (const hero of f.state().player.heros_info.heros.slice(0, 5)) f.advance(hero.guid, 12)
        assert(rows.every((row) => f.state().journey.targets[row.id].complete))
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [50301] }),
            (error) => error.code === ErrorCode.JourneyTypeLock,
        )
        f.edit((state) => {
            // Imported unrelated introductory/commission prerequisites isolate
            // this family's reward tests, never12055 progress or completion.
            state.player.basic_info.lv = 80
            state.journey.tasks[20000] = { complete: true, claimed: true }
            state.journey.claimRevision++
        })
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [50301] }),
            (error) => error.code === ErrorCode.JourneyTypeLock,
        )
        f.edit((state) => {
            state.entrust ??= { records: {} }
            state.entrust.records[1] = { entrust_id: 1, entrust_star: 1, success_time: '1799999900' }
        })
        for (const task of [50301, 50302, 50303, 50304, 50305, 50306]) {
            const packets = f.call('JourneyTaskFinish', { u32s: [task] })
            assert(f.reply(packets, 9869).rewards.length > 0)
            assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [task] }), 9869).rewards, [])
        }
        assert(
            [4050301, 4050302, 4050303, 4050304, 4050305, 4050306].every((id) => f.state().journey.targets[id].claimed),
        )
    } finally {
        f.store.close()
    }
})

test('commission star changes invalidate the same-length prerequisite cache and stable callbacks do not republish', () => {
    const f = heroRankProgressFixture('rank-journey-prerequisite')
    try {
        const state = structuredClone(f.state()),
            packets = []
        state.journey.tasks[20000] = { complete: true, claimed: true }
        state.journey.claimRevision++
        state.entrust ??= { records: {} }
        state.entrust.records[1] = { entrust_id: 1, entrust_star: 0, success_time: '0' }
        journeySnapshot(f.tables, state)
        const c = { tables: f.tables, state, now: 1800000000, pushBefore: (name, data) => packets.push({ name, data }) }
        notifyJourney(c, 'CSProtoEntrustInfoSync')
        assert.equal(packets.length, 0)
        state.entrust.records[1].entrust_star = 1
        notifyJourney(c, 'CSProtoEntrustInfoSync')
        assert.equal(packets.length, 1)
        assert.equal(packets[0].data.journey_task.find((row) => row.task_id === 50301).task_is_unlock, true)
        notifyJourney(c, 'CSProtoStoryEnd')
        assert.equal(packets.length, 1)
    } finally {
        f.store.close()
    }
})

test('rank journey progress and rewards survive SQLite reopen and do not leak to another account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-rank-journey-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = heroRankProgressFixture('rank-journey-persist', file)
        f.advance(f.state().player.heros_info.heros[0].guid, 4)
        f.edit((state) => {
            state.player.basic_info.lv = 80
            state.journey.tasks[20000] = { complete: true, claimed: true }
            state.journey.claimRevision++
            state.entrust ??= { records: {} }
            state.entrust.records[1] = { entrust_id: 1, entrust_star: 1, success_time: '1799999900' }
        })
        const encode = f.protocol.encode
        for (const type of ['SCJourneySync', 'Rewards']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('rank journey claim codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('JourneyTaskFinish', { u32s: [50301] }), /rank journey claim codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('JourneyTaskFinish', { u32s: [50301] })
        const value = f.state().journey.targets[4050301].value
        f.store.close()
        f = heroRankProgressFixture('rank-journey-persist', file)
        assert.equal(f.state().journey.targets[4050301].value, value)
        assert(f.state().journey.targets[4050301].complete)
        assert(f.state().journey.targets[4050301].claimed)
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [50301] }), 9869).rewards, [])
        const next = heroRankProgressFixture('rank-journey-other', file)
        try {
            assert.equal(next.state().journey.targets[4050301].complete, false)
        } finally {
            next.store.close()
        }
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-rank-journey-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('the next ordinary request observes changed commission stars even without an Entrust packet name', () => {
    const f = heroRankProgressFixture('rank-journey-ordinary-request')
    try {
        f.edit((state) => {
            state.player.basic_info.lv = 80
            state.journey.tasks[20000] = { complete: true, claimed: true }
            state.journey.claimRevision++
            state.entrust ??= { records: {} }
            state.entrust.records[1] = { entrust_id: 1, entrust_star: 0, success_time: '0' }
        })
        f.call('ActivityGet')
        assert.equal(
            f.call('ActivityGet').some((row) => row.id === 11880),
            false,
        )
        // Imported server history isolates observer routing, not a claim that
        // this test replays the commission battle's complete victory producer.
        f.edit((state) => {
            state.entrust.records[1].entrust_star = 1
        })
        const packets = f.call('ActivityGet'),
            sync = f.protocol.decode('SCJourneySync', packets.find((row) => row.id === 11880).payload)
        assert.equal(sync.journey_task.find((row) => row.task_id === 50301).task_is_unlock, true)
        assert.equal(
            f.call('ActivityGet').some((row) => row.id === 11880),
            false,
        )
        const state = structuredClone(f.state())
        Object.defineProperty(state, 'taskRecords', {
            get() {
                throw Error('stable unrelated request scanned tasks')
            },
        })
        const c = {
            tables: f.tables,
            state,
            now: 1800000000,
            pushBefore: () => {
                throw Error('unexpected stable sync')
            },
        }
        for (let n = 0; n < 100; n++) notifyJourney(c, 'CSProtoWorldObjInteract')
        for (const stars of [-1, 4, '1']) {
            const invalid = structuredClone(f.state())
            invalid.entrust.records[1].entrust_star = stars
            assert.throws(
                () => notifyJourney({ ...c, state: invalid }, 'CSProtoWorldObjInteract'),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
    } finally {
        f.store.close()
    }
})
