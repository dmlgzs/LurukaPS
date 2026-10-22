import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { Tables } from '../src/player.js'
import { journeyModel, journeySnapshot, journeyLedger, notifyJourney } from '../src/journey.js'
import { grantRewards } from '../src/rewards.js'

function watchSnapshots(model) {
    let calls = 0
    const arrays = [model.tabs, model.tasks, model.referencedTargets]
    const originals = arrays.map((array) => array.map)
    arrays.forEach((array, i) => {
        array.map = function (...args) {
            calls++
            return originals[i].apply(this, args)
        }
    })
    return {
        count: () => calls,
        reset: () => {
            calls = 0
        },
        restore: () =>
            arrays.forEach((array, i) => {
                array.map = originals[i]
            }),
    }
}
function context(f, state = f.state()) {
    const packets = []
    return {
        state,
        tables: f.tables,
        now: 1800000000,
        pushBefore: (name, value) => packets.push({ name, value }),
        packets,
    }
}
test('stable Task, Story and GM requests never construct a full journey snapshot or serialize the account', () => {
    const f = achievementFixture('journey-performance-stable'),
        model = journeyModel(f.tables),
        spy = watchSnapshots(model)
    try {
        const c = context(f),
            stringify = JSON.stringify,
            before = f.store.db.prepare('SELECT total_changes() AS n').get().n
        JSON.stringify = function (value, ...args) {
            assert.notEqual(value, c.state, 'whole account serialization')
            return stringify.call(this, value, ...args)
        }
        try {
            for (let n = 0; n < 100; n++)
                for (const name of ['CSProtoTaskClientAfter', 'CSProtoStoryEnd', 'CSProtoGMCommand'])
                    notifyJourney(c, name)
        } finally {
            JSON.stringify = stringify
        }
        assert.equal(spy.count(), 0)
        assert.equal(c.packets.length, 0)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before)
    } finally {
        spy.restore()
        f.store.close()
    }
})
test('changing the actual finished node at the same array length synchronizes its target immediately', () => {
    const f = achievementFixture('journey-performance-node'),
        model = journeyModel(f.tables),
        spy = watchSnapshots(model)
    try {
        const c = context(f)
        c.state.tasks = [{ task_id: 106010, finish_nodes: [151] }]
        notifyJourney(c, 'CSProtoTaskClientAfter')
        c.packets.length = 0
        spy.reset()
        c.state.tasks[0].finish_nodes[0] = 152
        notifyJourney(c, 'CSProtoTaskClientAfter')
        assert.equal(c.state.tasks[0].finish_nodes.length, 1)
        assert.equal(c.packets.length, 1)
        assert.equal(c.packets[0].value.journey_target.find((r) => r.target_id === 1010005).target_reward_status, 1)
        assert.equal(spy.count(), 3)
        notifyJourney(c, 'CSProtoTaskClientAfter')
        assert.equal(spy.count(), 3)
        assert.equal(c.packets.length, 1)
    } finally {
        spy.restore()
        f.store.close()
    }
})
test('same-length task completion records unlock configured journeys without using a count-length shortcut', () => {
    const f = achievementFixture('journey-performance-completion'),
        model = journeyModel(f.tables),
        spy = watchSnapshots(model)
    try {
        const row = model.tasks.find((r) => r.tabId !== 1 && r.unlockRules.some((rule) => rule[0] === 2007))
        assert.ok(row)
        const taskId = row.unlockRules.find((rule) => rule[0] === 2007)[1],
            c = context(f)
        c.state.journey.tasks[20000] = { complete: true, claimed: true }
        c.state.journey.claimRevision++
        c.state.taskRecords = [{ task_id: taskId, count: 0 }]
        notifyJourney(c, 'CSProtoTaskClientAfter')
        assert.equal(c.packets.at(-1).value.journey_task.find((r) => r.task_id === row.id).task_is_unlock, false)
        c.packets.length = 0
        spy.reset()
        c.state.taskRecords[0].count = 1
        notifyJourney(c, 'CSProtoTaskClientAfter')
        assert.equal(c.state.taskRecords.length, 1)
        assert.equal(c.packets.length, 1)
        assert.equal(c.packets[0].value.journey_task.find((r) => r.task_id === row.id).task_is_unlock, true)
        notifyJourney(c, 'CSProtoStoryEnd')
        assert.equal(c.packets.length, 1)
        assert.equal(spy.count(), 3)
    } finally {
        spy.restore()
        f.store.close()
    }
})
test('a real stage reward claim advances the claim revision and unlocks the next stage once', () => {
    const f = achievementFixture('journey-performance-claim'),
        model = journeyModel(f.tables),
        spy = watchSnapshots(model)
    try {
        // Imported/future completion receipts isolate the claim invalidation;
        // this does not implement the currently missing target producers.
        f.store.transact(f.session.id, 0, (s) => {
            for (const id of model.byTask.get(20000).ids)
                s.journey.targets[id] = { value: model.byTarget.get(id).targetParam, complete: true, claimed: false }
        })
        const old = f.state().journey.claimRevision
        const packets = f.call('JourneyTaskFinish', { u32s: [20000] })
        assert.equal(f.state().journey.claimRevision, old + 1)
        const data = f.protocol.decode('SCJourneySync', packets.find((p) => p.id === 11880).payload)
        assert.equal(data.journey_task.find((r) => r.task_id === 20001).task_is_unlock, true)
        spy.reset()
        const repeated = f.call('JourneyTaskFinish', { u32s: [20000] })
        assert.equal(f.state().journey.claimRevision, old + 1)
        assert.equal(
            repeated.some((p) => p.id === 11880),
            false,
        )
        assert.equal(spy.count(), 0)
    } finally {
        spy.restore()
        f.store.close()
    }
})
test('one snapshot memoizes prerequisite chains instead of reevaluating every ancestor for every task', () => {
    const f = achievementFixture('journey-performance-memo'),
        model = journeyModel(f.tables)
    try {
        const state = f.state(),
            ledger = journeyLedger(state)
        state.player.basic_info.lv = 80
        ledger.tasks[20000] = { complete: true, claimed: true }
        state.taskRecords = model.sourceTaskIds.map((task_id) => ({ task_id, count: 1 }))
        for (const task of model.tasks)
            for (const [kind, id] of task.unlockRules)
                if (kind === 12098) ledger.tasks[id] = { complete: true, claimed: true }
        let reads = 0
        for (const row of model.targets) {
            const receipt = { value: row.targetParam, complete: true, claimed: false }
            Object.defineProperty(ledger.targets, row.id, {
                enumerable: true,
                configurable: true,
                get() {
                    reads++
                    return receipt
                },
            })
        }
        const data = journeySnapshot(f.tables, state)
        assert.equal(data.journey_task.length, 259)
        assert.ok(data.journey_task.filter((r) => r.task_is_unlock).length > 200)
        assert.ok(
            reads <= model.owner.size * 5 + model.targets.length,
            `target reads ${reads} exceeded a linear snapshot bound`,
        )
    } finally {
        f.store.close()
    }
})
test('new nonzero selectors are not silently accepted as the current supported condition shape', () => {
    const f = achievementFixture('journey-performance-shapes')
    try {
        for (const kind of [13006, 13035, 12046]) {
            const tables = new Tables(f.cfg.tables),
                rows = tables.get('journey_task_target').map((r) => ({ ...r }))
            const row = rows.find((r) => Number(r.condition.split('|')[0]) === kind),
                original = journeyModel(f.tables).byTarget.get(row.id)
            assert.equal(original.supported, true)
            const tokens = row.condition.split('|')
            tokens[1] = '1'
            row.condition = tokens.join('|')
            tables.cache.set('journey_task_target', rows)
            assert.equal(journeyModel(tables).byTarget.get(row.id).supported, false)
        }
    } finally {
        f.store.close()
    }
})

// Native dispatch has no matching local node for this selector.
test('unproven native selector12235 remains in the catalogue but cannot manufacture completion', () => {
    const f = achievementFixture('journey-native-selector')
    try {
        assert(
            journeyModel(f.tables)
                .byKind.get(12235)
                .every((r) => !r.supported),
        )
    } finally {
        f.store.close()
    }
})

test('a real pet reward under a task request observes ownership without waiting for a pet packet or relog', () => {
    const f = achievementFixture('journey-cross-domain-pet')
    try {
        const c = context(f)
        c.state.pets = []
        c.state.petRevision = (c.state.petRevision ?? 0) + 1
        c.state.journey.targets = {}
        c.state.journey.targetRevision++
        delete c.state.journey.sourceSignature
        notifyJourney(c, 'CSProtoGMCommand')
        assert.equal(c.state.journey.targets[4060001].complete, false)
        c.packets.length = 0
        grantRewards(c.tables, c.state, [{ itemtype: 5, itemid: 500093, itemnum: 1 }])
        notifyJourney(c, 'CSProtoTaskClientAfter')
        assert.equal(c.state.journey.targets[4060001].complete, true)
        assert.equal(c.packets.length, 1)
        notifyJourney(c, 'CSProtoTaskClientAfter')
        assert.equal(c.packets.length, 1)
    } finally {
        f.store.close()
    }
})

test('passive home revisions update existing home-level conditions even on an unrelated request', () => {
    const f = achievementFixture('journey-cross-domain-home')
    try {
        const c = context(f)
        c.state.home.level = 1
        c.state.journey.targets = {}
        c.state.journey.targetRevision++
        delete c.state.journey.sourceSignature
        notifyJourney(c, 'CSProtoGMCommand')
        assert.equal(c.state.journey.targets[1420305].complete, false)
        c.packets.length = 0
        c.state.home.level = 20
        c.state.homeRevision = (c.state.homeRevision ?? 0) + 1
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(c.state.journey.targets[1420305].complete, true)
        assert.equal(c.packets.length, 1)
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(c.packets.length, 1)
    } finally {
        f.store.close()
    }
})
