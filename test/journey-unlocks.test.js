import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { productionProgressFixture } from './production-progress-fixture.js'
import { journeyModel, journeySnapshot, journeyUnlocked, notifyJourney } from '../src/journey.js'
import { compileJourneyUnlocks } from '../src/journey-unlocks.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name, file) {
    const f = productionProgressFixture(name, file)
    f.game.rng = (minimum) => minimum
    f.edit((state) => {
        state.journey.tasks[20000] = { complete: true, claimed: true }
        state.journey.claimRevision++
    })
    return f
}
const unlocked = (f, id) => journeyUnlocked(journeyModel(f.tables), f.state(), journeyModel(f.tables).byTask.get(id))
const ready = (data, id) => data.journey_task.find((row) => row.task_id === id).task_is_unlock
function submit(f, slot) {
    const row = f.tables.get('home_exchange_order').find((row) => row.orderID === slot.order_id)
    f.edit((state) => grantRewards(f.tables, state, parseRewards(row.orderNeedMaterials)))
    return f.call('CSFinishOrder', { order_guid: slot.guid })
}

test('both complete property unlock families compile while unproven systems remain closed', () => {
    const f = fixture('journey-unlocks-model')
    try {
        const model = journeyModel(f.tables)
        assert.deepEqual(model.byTask.get(30031).unlockRules, [[12042, 7]])
        assert.deepEqual(model.byTask.get(60202).unlockRules, [
            [12096, 60201],
            [12042, 5004],
        ])
        assert.deepEqual(model.sourceReputationIds, [10])
        const count = (kind) =>
            f.tables.get('journey_task').filter((row) =>
                String(row.unlockCondition)
                    .split('|')
                    .some((rule) => rule.startsWith(kind + '#')),
            ).length
        assert.equal(count(15017), 7)
        assert.equal(count(12042), 3)
        assert.equal(count(61001), 2)
        for (const text of ['61001#10#0', '61001#10#3#1', '15017#0', '15017#46#1'])
            assert.throws(
                () => compileJourneyUnlocks(f.tables, text),
                (error) => error.code === ErrorCode.JourneyConfError,
            )
        assert.deepEqual(compileJourneyUnlocks(f.tables, '12042#7'), [[12042, 7]])
    } finally {
        f.store.close()
    }
})

test('real order6227 reputation rewards unlock both cooking cards only at table level3 and enable real cooking rewards once', () => {
    const f = fixture('journey-unlocks-reputation')
    try {
        assert.equal(f.state().reputations[10].level, 1)
        assert(!unlocked(f, 30204))
        assert(!unlocked(f, 30205))
        let transition
        for (let day = 0; day < 5 && f.state().reputations[10].level < 3; day++) {
            f.call('CSExchangeOrderBoard')
            const slots = f.state().homeExchange.board.slots.filter((slot) => slot.guid && !slot.done)
            for (const slot of slots) {
                const before = f.state().reputations[10].level
                const packets = submit(f, slot)
                if (before < 3 && f.state().reputations[10].level >= 3) {
                    transition = packets
                    break
                }
                if (f.state().reputations[10].level < 3) {
                    assert(!unlocked(f, 30204))
                    assert(!unlocked(f, 30205))
                }
            }
            if (f.state().reputations[10].level < 3) f.advance(86400)
        }
        assert.equal(f.state().reputations[10].level, 3)
        assert(transition)
        const sync = f.protocol.decode('SCJourneySync', transition.find((packet) => packet.id === 11880).payload)
        assert(ready(sync, 30204))
        assert(ready(sync, 30205))
        const ack = transition.findIndex((packet) => packet.id === 6227)
        assert(transition.findIndex((packet) => packet.id === 11880) < ack)
        for (const [recipe, task, target] of [
            [9103201, 30204, 2030204],
            [9103301, 30205, 2030205],
        ]) {
            f.produce(recipe)
            const packets = f.call('JourneyTaskFinish', { u32s: [task] })
            assert(
                f.protocol.decode('Rewards', packets.find((packet) => packet.id === 9869).payload).rewards.length > 0,
            )
            assert(f.state().journey.targets[target].claimed)
            assert.deepEqual(
                f.protocol.decode(
                    'Rewards',
                    f.call('JourneyTaskFinish', { u32s: [task] }).find((packet) => packet.id === 9869).payload,
                ).rewards,
                [],
            )
        }
    } finally {
        f.store.close()
    }
})

test('home property thresholds preserve sequential completion gates and publish even after existing home-level targets are complete', () => {
    const f = fixture('journey-unlocks-home')
    try {
        const state = structuredClone(f.state()),
            model = journeyModel(f.tables),
            packets = []
        for (const row of model.byKind.get(15017))
            state.journey.targets[row.id] = { value: row.targetParam, complete: true, claimed: false }
        // Unrelated earlier card completion is imported only to isolate each
        // unlock threshold; no new target producer is claimed by this test.
        for (const id of [2030026, 2030101, 2030102, 2030103, 2030104]) {
            const row = model.byTarget.get(id)
            state.journey.targets[id] = { value: row.targetParam, complete: true, claimed: false }
        }
        const c = { tables: f.tables, state, now: 1800000000, pushBefore: (name, data) => packets.push({ name, data }) }
        const levels = [
            [16, 30026],
            [20, 30101],
            [25, 30102],
            [30, 30103],
            [35, 30104],
            [40, 30105],
            [46, 30027],
        ]
        for (const [level, id] of levels) {
            state.home.level = level - 1
            journeySnapshot(f.tables, state)
            assert.equal(journeyUnlocked(model, state, model.byTask.get(id)), false, String(id))
            const needed = f.tables
                .get('home_level')
                .filter((row) => row.id < level)
                .reduce((sum, row) => sum + row.exp, 0)
            // Use the canonical XP producer, not player.basic_info.home_lv.
            state.home.level = 1
            state.home.exp = 0
            state.home.experienceTotal = '0'
            state.home.levelRewardedThrough = 1
            grantRewards(f.tables, state, [{ itemtype: 10, itemid: 1003, itemnum: needed }])
            assert.equal(state.home.level, level)
            assert.equal(journeyUnlocked(model, state, model.byTask.get(id)), true, String(id))
            notifyJourney(c, 'CSProtoAddChat')
            assert(ready(packets.at(-1).data, id))
            const n = packets.length
            notifyJourney(c, 'CSProtoAddChat')
            assert.equal(packets.length, n)
        }
    } finally {
        f.store.close()
    }
})

test('actual order and journey reward codec failures roll back reputation, unlock signature, materials and claims atomically', () => {
    const f = fixture('journey-unlocks-rollback'),
        encode = f.protocol.encode
    try {
        // Canonical existing reputation history, below level3. This does not
        // inject a journey receipt; the threshold-crossing event is real6227.
        f.edit((state) => grantRewards(f.tables, state, [{ itemtype: 29, itemid: 10, itemnum: 400 }]))
        f.call('CSExchangeOrderBoard')
        const slot = f.state().homeExchange.board.slots.find((slot) => slot.guid && !slot.done)
        const row = f.tables.get('home_exchange_order').find((row) => row.orderID === slot.order_id)
        f.edit((state) => grantRewards(f.tables, state, parseRewards(row.orderNeedMaterials)))
        const response = f.protocol.byName.get('CSProtoCSFinishOrder').rsp
        for (const type of ['SCJourneySync', response]) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name === type || name.replace(/^cs\./, '') === type) throw Error('unlock order codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('CSFinishOrder', { order_guid: slot.guid }), /unlock order codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('CSFinishOrder', { order_guid: slot.guid })
        assert.equal(f.state().reputations[10].level, 3)
        f.produce(9103201)
        for (const type of ['SCJourneySync', 'Rewards']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('unlock claim codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('JourneyTaskFinish', { u32s: [30204] }), /unlock claim codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('JourneyTaskFinish', { u32s: [30204] })
        assert(f.state().journey.targets[2030204].claimed)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('only referenced reputation level changes publish unlocks; unrelated groups and within-level rewards remain quiet', () => {
    const f = fixture('journey-unlocks-reputation-source')
    try {
        const state = structuredClone(f.state()),
            packets = []
        journeySnapshot(f.tables, state)
        const c = { tables: f.tables, state, now: 1800000000, pushBefore: (name, data) => packets.push({ name, data }) }
        grantRewards(f.tables, state, [{ itemtype: 29, itemid: 11, itemnum: 420 }])
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(packets.length, 0)
        grantRewards(f.tables, state, [{ itemtype: 29, itemid: 10, itemnum: 20 }])
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(packets.length, 0)
        grantRewards(f.tables, state, [{ itemtype: 29, itemid: 10, itemnum: 400 }])
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(packets.length, 1)
        assert(ready(packets[0].data, 30204))
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(packets.length, 1)
    } finally {
        f.store.close()
    }
})

test('actual reputation-based cooking claim remains unlocked and idempotent after SQLite reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-unlocks-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = fixture('journey-unlocks-persist', file)
        f.edit((state) => grantRewards(f.tables, state, [{ itemtype: 29, itemid: 10, itemnum: 400 }]))
        f.call('CSExchangeOrderBoard')
        submit(
            f,
            f.state().homeExchange.board.slots.find((slot) => slot.guid && !slot.done),
        )
        assert.equal(f.state().reputations[10].level, 3)
        f.produce(9103201)
        f.call('JourneyTaskFinish', { u32s: [30204] })
        f.store.close()
        f = fixture('journey-unlocks-persist', file)
        assert(unlocked(f, 30204))
        assert(f.state().journey.targets[2030204].claimed)
        assert.deepEqual(
            f.protocol.decode(
                'Rewards',
                f.call('JourneyTaskFinish', { u32s: [30204] }).find((packet) => packet.id === 9869).payload,
            ).rewards,
            [],
        )
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-unlocks-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('unproven system ledger is not replaced with its configuration conditions', () => {
    const f = fixture('journey-unlocks-systems')
    try {
        const state = structuredClone(f.state()),
            model = journeyModel(f.tables),
            packets = []
        state.taskRecords = state.taskRecords.filter((row) => row.task_id !== 106010)
        state.tasks = []
        state.player.basic_info.lv = 19
        const prerequisite = model.byTarget.get(4060201)
        state.journey.targets[prerequisite.id] = { value: prerequisite.targetParam, complete: true, claimed: false }
        journeySnapshot(f.tables, state)
        assert(!journeyUnlocked(model, state, model.byTask.get(30031)))
        assert(!journeyUnlocked(model, state, model.byTask.get(60202)))
        const c = { tables: f.tables, state, now: 1800000000, pushBefore: (name, data) => packets.push({ name, data }) }
        state.tasks = [{ task_id: 106010, finish_nodes: [155] }]
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(journeyUnlocked(model, state, model.byTask.get(30031)), false)
        assert.equal(journeyUnlocked(model, state, model.byTask.get(30507)), false)
        state.player.basic_info.lv = 20
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(journeyUnlocked(model, state, model.byTask.get(60202)), false)
        const count = packets.length
        notifyJourney(c, 'CSProtoAddChat')
        assert.equal(packets.length, count)
    } finally {
        f.store.close()
    }
})
