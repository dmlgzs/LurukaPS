import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { achievementFixture } from './achievement-fixture.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { isFieldChest, worldChestsOpened } from '../src/world-chest-progress.js'
import { journeyModel, journeyValue, notifyJourney } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards } from '../src/rewards.js'

const tiers = [3070307, 3070308, 3070309]
const tasks = [70307, 70308, 70309]
function fixture(name, file = ':memory:') {
    const f = achievementFixture(name, file),
        catalog = new WorldObjectCatalog(f.tables)
    const chests = catalog
        .get('worldmap_101')
        .filter(
            (row) =>
                row.cityId === 101 &&
                !row.initialCompleteState &&
                !row.appearCond &&
                !row.disappearCond &&
                row.statusReward &&
                isFieldChest(f.tables, 101, catalog.find('world_spawner', row.spawnerId)),
        )
    assert(chests.length >= 20)
    const edit = (fn) => f.store.transact(f.session.id, 0, fn)
    edit((s) => {
        s.world.map_id = 101
    })
    const open = (id, complete = true, state_data = {}) => {
        edit((s) => {
            s.world.pos = catalog.object(101, id).pos
        })
        return f.call('WorldObjInteract', { objs: [{ obj: { obj_id: id, complete, state_data }, interact_type: 0 }] })
    }
    const legacy = (count) =>
        edit((s) => {
            s.worldObjects = Object.fromEntries(
                chests
                    .slice(1, count + 1)
                    .map((row) => [
                        '101:' + row.id,
                        { obj_id: row.id, complete: true, claims: { complete: true, drops: {} } },
                    ]),
            )
            delete s.worldChestHistory
        })
    // Only import the unrelated introductory tab prerequisite. No chest target
    // completion/claim receipt is ever injected by this helper.
    const unlockTab = () =>
        edit((s) => {
            s.journey.tasks[20000] = { complete: true, claimed: true }
            s.journey.claimRevision++
        })
    return { ...f, catalog, chests, edit, open, legacy, unlockTab }
}
const counts = (f) => tiers.map((id) => f.state().journey.targets[id]?.value ?? 0)
const decode = (f, packets) => f.protocol.decode('SCJourneySync', packets.find((row) => row.id === 11880).payload)

test('the complete current12072 journey family compiles exact wildcard shapes and preserves unknown selectors', () => {
    const f = fixture('chest-journey-model')
    try {
        const model = journeyModel(f.tables),
            family = model.referencedTargets.filter((r) => r.tokens[0] === 12072)
        assert.deepEqual(
            family.map((r) => r.id),
            tiers,
        )
        assert.deepEqual(
            family.map((r) => r.targetParam),
            [1, 10, 20],
        )
        assert(family.every((r) => r.supported))
        assert.equal(model.targets.filter((r) => r.supported).length, 126)
        assert.equal(model.referencedTargets.filter((r) => r.supported).length, 110)
        for (const condition of ['12072|1|1', '12072|0|1|2', '12072|0|2']) {
            const adapter = Object.create(f.tables)
            adapter.get = (name) =>
                name === 'journey_task_target'
                    ? f.tables.get(name).map((r) => (r.id === tiers[0] ? { ...r, condition } : r))
                    : f.tables.get(name)
            assert.equal(journeyModel(adapter).byTarget.get(tiers[0]).supported, false)
        }
        assert(family.every((r) => journeyValue(f.tables, f.state(), r) === 0))
    } finally {
        f.store.close()
    }
})

test('twenty actual distinct field chest claims reach all tiers and current task-ID rewards remain gated and idempotent', () => {
    const f = fixture('chest-journey-real-twenty')
    try {
        for (let n = 1; n <= 20; n++) {
            const packets = f.open(f.chests[n - 1].id)
            assert.deepEqual(counts(f), [1, Math.min(n, 10), n])
            const sync = decode(f, packets)
            assert.equal(sync.journey_target.find((r) => r.target_id === tiers[2]).target_progress[0].condition_val, n)
            if ([1, 10, 20].includes(n)) {
                const index = [1, 10, 20].indexOf(n),
                    id = tasks[index]
                if (n === 1) {
                    const before = structuredClone(f.state())
                    assert.throws(
                        () => f.call('JourneyTaskFinish', { u32s: [id] }),
                        (e) => e.code === ErrorCode.JourneyTypeLock,
                    )
                    assert.deepEqual(f.state(), before)
                    f.unlockTab()
                }
                const result = f.call('JourneyTaskFinish', { u32s: [id] })
                const rewards = f.reply(result, 9869).rewards
                assert(rewards.some((r) => r.itemtype === 10 && r.itemid === 2 && r.itemnum === 1000))
                assert(rewards.some((r) => r.itemtype === 10 && r.itemid === 707 && r.itemnum === 10))
                assert.equal(f.state().journey.targets[tiers[index]].claimed, true)
                const bag = structuredClone(f.state().player)
                assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [id] }), 9869).rewards, [])
                assert.deepEqual(f.state().player, bag)
            }
        }
        assert.equal(f.state().worldChestHistory.total, 20)
        // Current weekly task caps its own progress at10; lifetime must reach20.
        assert.equal(f.state().dailyActive.week.counts[12072], 10)
        assert(tiers.every((id) => f.state().journey.targets[id].claimed))
    } finally {
        f.store.close()
    }
})

test('stage updates, retries, gathering, unproved puzzle objects and ordinary grants never substitute for a chest claim', () => {
    const f = fixture('chest-journey-filter')
    try {
        f.open(f.chests[0].id, false, { step: 1, complete: true })
        assert.deepEqual(counts(f), [0, 0, 0])
        f.open(f.chests[0].id)
        assert.deepEqual(counts(f), [1, 1, 1])
        f.open(f.chests[0].id)
        f.open(500171)
        f.open(300040)
        f.edit((s) => grantRewards(f.tables, s, [{ itemtype: 3, itemid: 300000, itemnum: 10 }]))
        f.call('ActivityGet')
        assert.deepEqual(counts(f), [1, 1, 1])
        assert.equal(f.state().worldChestHistory.total, 1)
    } finally {
        f.store.close()
    }
})

test('confirmed legacy receipts advance only lifetime goals, then one real claim reaches ten without replaying period events', () => {
    const f = fixture('chest-journey-history')
    try {
        f.legacy(9)
        const periods = structuredClone(f.state().dailyActive)
        f.call('JourneyClientTrace', { journey_id: 0, is_trace: false })
        assert.deepEqual(counts(f), [1, 9, 9])
        assert.deepEqual(f.state().dailyActive, periods)
        f.open(f.chests[0].id)
        assert.deepEqual(counts(f), [1, 10, 10])
        assert.equal(f.state().dailyActive.week.counts[12072], 1)
        f.call('ActivityGet')
        assert.deepEqual(counts(f), [1, 10, 10])
    } finally {
        f.store.close()
    }
})

test('actual chest and journey reply encoding failures roll back loot, receipts, lifetime and target progress together', () => {
    const f = fixture('chest-journey-codec'),
        encode = f.protocol.encode
    try {
        const response = f.protocol.byName.get('CSProtoWorldObjInteract').rsp.replace(/^cs\./, '')
        // Position is accepted before the request; compare the transaction itself.
        f.edit((s) => {
            s.world.pos = f.catalog.object(101, f.chests[0].id).pos
        })
        const request = { objs: [{ obj: { obj_id: f.chests[0].id, complete: true }, interact_type: 0 }] }
        for (const type of ['SCJourneySync', response]) {
            const shared = f.state(),
                before = structuredClone(shared)
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('chest journey claim encoding failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('WorldObjInteract', request), /chest journey claim encoding failure/)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(shared, before)
            f.protocol.encode = encode
        }
        f.call('WorldObjInteract', request)
        assert.deepEqual(counts(f), [1, 1, 1])
        f.unlockTab()
        for (const type of ['SCJourneySync', 'Rewards']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('chest journey reward encoding failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(
                () => f.call('JourneyTaskFinish', { u32s: [tasks[0]] }),
                /chest journey reward encoding failure/,
            )
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('JourneyTaskFinish', { u32s: [tasks[0]] })
        assert(f.state().journey.targets[tiers[0]].claimed)
        f.edit((s) => {
            s.worldChestHistory = { version: 1, total: -1 }
        })
        const corrupt = structuredClone(f.state())
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [tasks[1]] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), corrupt)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('stable task callbacks read only the aggregate and never scan historical objects or add SQL work', () => {
    const f = fixture('chest-journey-stable')
    try {
        f.open(f.chests[0].id)
        const state = structuredClone(f.state()),
            packets = []
        Object.defineProperty(state, 'worldObjects', {
            get() {
                throw Error('unexpected world history scan')
            },
        })
        const before = f.store.db.prepare('SELECT total_changes() AS n').get().n
        const context = {
            tables: f.tables,
            state,
            now: 1800000000,
            pushBefore: (name, data) => packets.push({ name, data }),
        }
        assert.equal(worldChestsOpened(f.tables, state), 1)
        for (let n = 0; n < 100; n++) notifyJourney(context, 'CSProtoTaskClientAfter')
        assert.equal(packets.length, 0)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before)
    } finally {
        f.store.close()
    }
})

test('real SQLite reopen and separate accounts preserve once-only goals and rewards', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-chest-journey-'))
    let f, other
    try {
        const file = path.join(directory, 'state.sqlite')
        f = fixture('chest-journey-persist', file)
        const id = f.chests[0].id
        f.open(id)
        f.unlockTab()
        f.call('JourneyTaskFinish', { u32s: [tasks[0]] })
        const saved = structuredClone(f.state().journey.targets)
        f.store.close()
        f = fixture('chest-journey-persist', file)
        assert.deepEqual(f.state().journey.targets, saved)
        const player = structuredClone(f.state().player)
        f.open(id)
        assert.deepEqual(f.state().player, player)
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [tasks[0]] }), 9869).rewards, [])
        assert.deepEqual(counts(f), [1, 1, 1])
        other = fixture('chest-journey-other', file)
        assert.deepEqual(counts(other), [0, 0, 0])
        assert.equal(other.state().worldChestHistory.total, 0)
    } finally {
        other?.store.close()
        f?.store.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-chest-journey-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
