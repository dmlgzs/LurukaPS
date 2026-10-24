import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { journeyModel, journeyValue, observeJourney, notifyJourney } from '../src/journey.js'

function history(f, count) {
    // Imported canonical catch history, ordered by evolution family to expose
    // the old family collapse. No claim this test caught all these species.
    const ranks = f.tables
            .get('pet_rank')
            .slice()
            .sort((a, b) => a.petGroup - b.petGroup || a.petId - b.petId),
        selected = ranks.slice(0, count)
    assert.equal(selected.length, count)
    assert(new Set(selected.map((row) => row.petGroup)).size < count)
    f.store.transact(f.session.id, 0, (s) => {
        s.petCaptureResults = Object.fromEntries(
            selected.map((row, index) => [index, { guid: String(index + 1), pet_id: row.petId }]),
        )
    })
    return selected
}

test('all five current journey species targets count configuration IDs rather than evolution families', () => {
    const f = achievementFixture('journey-capture-varieties')
    try {
        const model = journeyModel(f.tables),
            targets = model.byKind.get(12046)
        assert.equal(targets.length, 5)
        history(f, 50)
        const state = f.state()
        for (const row of targets) assert.equal(journeyValue(f.tables, state, row), 50)
        observeJourney(f.tables, state, [12046])
        for (const row of targets) {
            assert.equal(state.journey.targets[row.id].value, row.targetParam)
            assert(state.journey.targets[row.id].complete)
        }
    } finally {
        f.store.close()
    }
})

test('real 9869 claim pays the ten-species target once while unrelated seeded pets and duplicate captures give no extra credit', () => {
    const f = achievementFixture('journey-capture-claim')
    try {
        const model = journeyModel(f.tables),
            target = model.byTarget.get(4060003),
            owner = model.byTask.get(model.owner.get(target.id)),
            tab = model.tabById.get(owner.tabId)
        const selected = history(f, 10)
        f.store.transact(f.session.id, 0, (s) => {
            // Supply only the real tab's imported prerequisite task/level facts;
            // the current target's completion still comes from catch receipts.
            for (const [kind, value] of tab.unlockRules) {
                if (kind === 2007) {
                    s.taskRecords ??= []
                    s.taskRecords.push({ task_id: value, count: 1, time: 1799999900 })
                } else if (kind === 2004) s.player.basic_info.lv = Math.max(s.player.basic_info.lv, value)
                else if (kind === 12098) s.journey.tasks[value] = { complete: true, claimed: true }
                else assert.fail('Unmodeled real tab prerequisite: ' + kind)
            }
            s.petCaptureResults.duplicate = { guid: '999', pet_id: selected[0].petId }
            s.petCaptureResults.unknown = { guid: '1000', pet_id: 0xffffffff }
            s.petCaptureResults.failed = { guid: '0', pet_id: f.tables.get('pet_rank')[20].petId }
        })
        const packets = f.call('JourneyTaskFinish', { u32s: [owner.id] }),
            reply = f.reply(packets, 9869)
        assert(reply.rewards.length > 0)
        assert(f.state().journey.targets[target.id].claimed)
        assert.equal(f.state().journey.targets[target.id].value, 10)
        assert.equal(f.state().journey.targets[4060004].value, 10)
        const state = structuredClone(f.state())
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [owner.id] }), 9869).rewards, [])
        assert.deepEqual(f.state().player.sbag_infos, state.player.sbag_infos)
        assert.equal(f.state().journey.claimRevision, state.journey.claimRevision)
    } finally {
        f.store.close()
    }
})

test('9869 re-observes changed capture history and an encoding failure rolls back the claim', () => {
    const f = achievementFixture('journey-capture-rollback')
    try {
        history(f, 9)
        const base = f.state(),
            target = journeyModel(f.tables).byTarget.get(4060003)
        assert.equal(journeyValue(f.tables, base, target), 9)
        history(f, 10)
        const model = journeyModel(f.tables),
            owner = model.byTask.get(model.owner.get(target.id)),
            tab = model.tabById.get(owner.tabId)
        f.store.transact(f.session.id, 0, (s) => {
            for (const [kind, id] of tab.unlockRules) {
                if (kind === 2007) {
                    s.taskRecords ??= []
                    s.taskRecords.push({ task_id: id, count: 1, time: 1799999900 })
                } else if (kind === 2004) s.player.basic_info.lv = Math.max(s.player.basic_info.lv, id)
                else if (kind === 12098) s.journey.tasks[id] = { complete: true, claimed: true }
                else assert.fail('Unmodeled real tab prerequisite: ' + kind)
            }
        })
        const before = structuredClone(f.state()),
            original = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'SCProtoJourneySync') throw Error('capture journey packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('JourneyTaskFinish', { u32s: [owner.id] }), /capture journey packet fault/)
        assert.deepEqual(f.state(), before)
        f.game.packet = original
        f.call('JourneyTaskFinish', { u32s: [owner.id] })
        assert(f.state().journey.targets[target.id].claimed)
    } finally {
        f.store.close()
    }
})

test('the existing catch observation domain immediately updates a newly caught species without extra database writes or duplicate pushes', () => {
    const f = achievementFixture('journey-capture-observe')
    try {
        const selected = history(f, 9),
            next = f.tables.get('pet_rank').find((row) => !selected.some((old) => old.petId === row.petId)),
            packets = [],
            c = { tables: f.tables, state: f.state(), pushBefore: (name, value) => packets.push({ name, value }) },
            changes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        notifyJourney(c, 'CSProtoCatchPet')
        packets.length = 0
        c.state.petCaptureResults.new = { guid: '10000', pet_id: next.petId }
        notifyJourney(c, 'CSProtoCatchPet')
        assert.equal(c.state.journey.targets[4060003].value, 10)
        assert.equal(packets.length, 1)
        assert.equal(packets[0].name, 'SCProtoJourneySync')
        assert(
            packets[0].value.journey_target.some((row) => row.target_id === 4060003 && row.target_reward_status === 1),
        )
        packets.length = 0
        notifyJourney(c, 'CSProtoCatchPet')
        assert.equal(packets.length, 0)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes)
    } finally {
        f.store.close()
    }
})
