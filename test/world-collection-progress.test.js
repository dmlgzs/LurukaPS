import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { worldCollectionProgressFixture } from './world-collection-progress-fixture.js'
import { journeyModel, journeyValue } from '../src/journey.js'
import { worldCollectionProgressRule, worldCollectionProgressValue } from '../src/world-collection-progress.js'
import { ErrorCode } from '../src/error-codes.js'

test('all five13039 targets use actual configured scene IDs and33 real repairs, not dispatch, production or building counts', () => {
    const f = worldCollectionProgressFixture('world-repair-family')
    try {
        const model = journeyModel(f.tables),
            rows = model.byKind.get(13039)
        assert.equal(rows.length, 5)
        assert(rows.every((row) => row.supported && journeyValue(f.tables, f.state(), row) === 0))
        assert.equal(model.targets.filter((row) => row.supported).length, 157)
        assert.equal(model.referencedTargets.filter((row) => row.supported).length, 141)
        for (const tokens of [
            [13039, 1, 0, 0, 1],
            [13039, 100, 1, 0, 1],
            [13039, 100, 0, 1, 1],
            [13039, 100, 0, 0, 0],
        ])
            assert.equal(worldCollectionProgressRule(f.tables, tokens), false)
        const worlds = f.tables.get('home_collection_world'),
            byScene = new Map()
        for (const world of worlds) {
            const scene = f.tables.get('domain').find((row) => row.domainId === world.domainId).sceneId
            byScene.set(scene, (byScene.get(scene) ?? 0) + 1)
            const packets = f.repair(world.id)
            assert(packets.some((row) => row.id === 6526))
            assert.equal(worldCollectionProgressValue(f.tables, f.state(), [13039, scene, 0, 0, 1]), byScene.get(scene))
        }
        assert.deepEqual(
            [...byScene].sort((a, b) => a[0] - b[0]),
            [
                [100, 19],
                [101, 14],
            ],
        )
        assert.equal(Object.keys(f.state().home.worldCollections).length, 33)
        assert(rows.every((row) => f.state().journey.targets[row.id].complete))
        const before = structuredClone(f.state())
        assert.equal(
            f.repair(worlds[0].id).some((row) => row.id === 11880),
            false,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(
            f.call('ActivityGet').some((row) => row.id === 11880),
            false,
        )
    } finally {
        f.store.close()
    }
})

test('13039 rejects counterfeit repair identities and building definitions and leaves unbuilt stubs or ordinary home buildings uncounted', () => {
    const f = worldCollectionProgressFixture('world-repair-domain')
    try {
        const world = f.tables.get('home_collection_world')[0],
            other = f.tables.get('home_collection_world')[1]
        const build = (w) =>
            f.tables.get('home_building_collection').find((row) => row.groupId === w.groupId && row.level === 1).id
        const tokens = [13039, 0, 0, 0, 1]
        assert.equal(
            worldCollectionProgressValue(
                f.tables,
                { home: { worldCollections: { [world.id]: { collect_id: world.id, build_id: 0 } } } },
                tokens,
            ),
            0,
        )
        assert.equal(
            worldCollectionProgressValue(f.tables, { home: { builds: [{ guid: 1, build_id: build(world) }] } }, tokens),
            0,
        )
        const valid = { guid: 9, collect_id: world.id, build_id: build(world) }
        assert.equal(
            worldCollectionProgressValue(f.tables, { home: { worldCollections: { [world.id]: valid } } }, tokens),
            1,
        )
        for (const entries of [
            { ['0' + world.id]: valid },
            { [world.id]: { ...valid, collect_id: other.id } },
            { [world.id]: { ...valid, build_id: build(other) } },
            { [world.id]: { ...valid, guid: 0 } },
            { [world.id]: valid, [other.id]: { ...valid, collect_id: other.id, build_id: build(other) } },
            [],
        ])
            assert.throws(
                () => worldCollectionProgressValue(f.tables, { home: { worldCollections: entries } }, tokens),
                (error) => error.code === ErrorCode.GameConfig,
            )
    } finally {
        f.store.close()
    }
})

test('actual repair and new13039 progress roll back together on sync and SQL failures; all five rewards remain gated and idempotent', () => {
    const f = worldCollectionProgressFixture('world-repair-atomic')
    try {
        const id = f.tables.get('home_collection_world')[0].id,
            before = structuredClone(f.state()),
            encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'SCJourneySync') throw Error('repair journey sync')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.repair(id), /repair journey sync/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_repair_progress BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'repair SQL'); END",
        )
        try {
            assert.throws(() => f.repair(id), /repair SQL/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.store.db.exec('DROP TRIGGER fail_repair_progress')
        }
        for (const world of f.tables.get('home_collection_world')) f.repair(world.id)
        f.edit((state) => {
            state.journey.tasks[20000] = { complete: true, claimed: true }
            state.journey.claimRevision++
        })
        for (const task of [30302, 30303, 30304]) {
            f.call('JourneyTaskFinish', { u32s: [task] })
            assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [task] }), 9869).rewards, [])
        }
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [30305] }),
            (error) => error.code === ErrorCode.JourneyTypeLock,
        )
        f.completedTask(996002)
        for (const task of [30305, 30306]) {
            const saved = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === 'Rewards') throw Error('repair reward ACK')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('JourneyTaskFinish', { u32s: [task] }), /repair reward ACK/)
                assert.deepEqual(f.state(), saved)
            } finally {
                f.protocol.encode = encode
            }
            f.call('JourneyTaskFinish', { u32s: [task] })
            assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [task] }), 9869).rewards, [])
        }
        assert(
            journeyModel(f.tables)
                .byKind.get(13039)
                .every((row) => f.state().journey.targets[row.id].claimed),
        )
    } finally {
        f.store.close()
    }
})

test('real repaired collection identities, progress and claims survive SQLite reopen without leaking across accounts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-repair-progress-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = worldCollectionProgressFixture('world-repair-persist', file)
        f.repair(f.tables.get('home_collection_world')[0].id)
        f.edit((state) => {
            state.journey.tasks[20000] = { complete: true, claimed: true }
            state.journey.claimRevision++
        })
        f.call('JourneyTaskFinish', { u32s: [30302] })
        const saved = structuredClone(f.state().home.worldCollections)
        f.store.close()
        f = worldCollectionProgressFixture('world-repair-persist', file)
        assert.deepEqual(f.state().home.worldCollections, saved)
        assert.equal(f.state().journey.targets[2030302].value, 1)
        assert.equal(f.state().journey.targets[2030302].claimed, true)
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [30302] }), 9869).rewards, [])
        const other = worldCollectionProgressFixture('world-repair-separate', file)
        try {
            assert.equal(worldCollectionProgressValue(other.tables, other.state(), [13039, 0, 0, 0, 1]), 0)
        } finally {
            other.store.close()
        }
    } finally {
        f?.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
        assert(path.basename(target).startsWith('world-repair-progress-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
