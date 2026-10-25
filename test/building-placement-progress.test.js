import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildingPlacementFixture } from './building-placement-progress-fixture.js'
import { buildingPlacementRule, buildingPlacementValue } from '../src/building-placement-progress.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'

const decoration = [15020, 3, 0, 1],
    dormitory = [13096, 5002, 1]
const value = (f, rule) => buildingPlacementValue(f.tables, f.state(), rule)
const targets = [2010008, 2010009]

test('the complete15020 and13096 families use synced owned type/group instances with the equivalent client status semantics', () => {
    const f = buildingPlacementFixture('placement-catalogue')
    try {
        const model = achievementCatalogue(f.tables)
        const rows = model.rows.filter((r) => /^(15020|13096)#/.test(r.finishCondition))
        assert.deepEqual(
            rows.map((r) => [r.id, r.finishCondition]),
            [
                [2010008, '13096#5002#1'],
                [2010009, '15020#3#0#1'],
            ],
        )
        assert(rows.every((r) => model.rules.get(r.id).supported))
        assert.equal([...model.rules.values()].filter((r) => r.supported).length, 102)
        const build = (guid, build_id, status = 1, build_type = 0) => ({
            guid,
            build_id,
            status,
            build_type,
            locate: { block_id: 101, anchor: 0 },
        })
        const source = {
            home: {
                builds: [build(1, 30051), build(2, 30061, 2), build(3, 50021, 3)],
                inventory: [{ build_id: 30051, total_num: 9999, used_num: 0, locate: { block_id: 101 } }],
                storedBuilds: [build(4, 30051)],
            },
        }
        assert.equal(buildingPlacementValue(f.tables, source, decoration), 2)
        assert.equal(buildingPlacementValue(f.tables, source, dormitory), 1)
        // These are legal wire/import status boundaries, not current timed
        // construction producers; neither positive client reader tests status.
        for (const status of [undefined, 0, 1, 2, 3, 4]) {
            source.home.builds[0].status = status
            assert.equal(buildingPlacementValue(f.tables, source, decoration), 2)
        }
        source.home.builds.push(build(0, 30051, 1, 53), build(0, 30051, 1, 55), build(0, 0), { guid: 0 })
        assert.equal(buildingPlacementValue(f.tables, source, decoration), 2)
        const facts = new Map()
        buildingPlacementValue(f.tables, source, decoration, facts)
        buildingPlacementValue(f.tables, source, dormitory, facts)
        assert.equal([...facts.keys()].filter((k) => k === 'building-placement:rows').length, 1)
        for (const rule of [
            [15020, 0, 0, 1],
            [15020, 9999, 0, 1],
            [15020, 3, 5002, 1],
            [15020, 3, 0, 0],
            [13096, 3005, 1],
            [13096, 9999, 1],
            [13096, 5002, 0],
            [13096, 5002, 1, 1],
        ]) {
            assert.equal(buildingPlacementRule(f.tables, rule), false)
            assert.equal(buildingPlacementValue(f.tables, source, rule), null)
        }
        for (const invalid of [
            { home: { builds: {} } },
            { home: { builds: [build(1, 30051), build(1, 30061)] } },
            { home: { builds: [build('1', 30051)] } },
            { home: { builds: [{ ...build(1, 30051), locate: null }] } },
            { home: { builds: [build(1, 999999)] } },
            { home: { builds: [build(1, 30051, -1)] } },
        ])
            assert.throws(
                () => buildingPlacementValue(f.tables, invalid, decoration),
                (e) => e.code === ErrorCode.GameConfig,
            )
    } finally {
        f.store.close()
    }
})

test('actual6105 places both current families, migration preserves GUID and removal/redeployment cannot duplicate permanent receipts', () => {
    const f = buildingPlacementFixture('placement-real-locate')
    try {
        f.call('EnterHome', {})
        f.own(30051, 2)
        f.own(50021)
        assert.equal(value(f, decoration), 0)
        assert.equal(value(f, dormitory), 0)
        const first = f.place(30051)
        assert.equal(first.build.status, 1)
        assert(first.packets.some((p) => p.id === 9900))
        assert(first.packets.findIndex((p) => p.id === 9900) < first.packets.findIndex((p) => p.id === 6105))
        const before = first.build.locate.anchor
        const moved = f.place(30051, first.build.guid)
        assert.equal(moved.build.guid, first.build.guid)
        assert.notEqual(moved.build.locate.anchor, before)
        assert.equal(value(f, decoration), 1)
        const second = f.place(30051)
        assert.notEqual(second.build.guid, first.build.guid)
        assert.equal(value(f, decoration), 2)
        const dorm = f.place(50021)
        assert.equal(dorm.build.status, 1)
        assert.equal(value(f, dormitory), 1)
        for (const id of targets) {
            assert.equal(f.state().achievements.entries[id].value, 1)
            assert(f.state().achievements.entries[id].finishTime > 0)
            f.call('AchievementReward', { u32: id })
        }
        const points = achievementPoints(f.tables, f.state())
        for (const entry of [first, second, dorm]) {
            const packets = f.call('BuildUnlocate', { guid: entry.build.guid })
            const home = f.protocol.decode('SCHomeSync', packets.find((p) => p.id === 6102).payload)
            assert(home.del_builds.includes(entry.build.guid))
        }
        assert.equal(value(f, decoration), 0)
        assert.equal(value(f, dormitory), 0)
        assert(targets.every((id) => f.state().achievements.entries[id].claimed))
        assert.equal(f.place(30051, first.build.guid).build.guid, first.build.guid)
        assert.equal(f.place(50021, dorm.build.guid).build.guid, dorm.build.guid)
        for (const id of targets) f.call('AchievementReward', { u32: id })
        assert.equal(achievementPoints(f.tables, f.state()), points)
        assert.equal(value(f, decoration), 1)
        assert.equal(value(f, dormitory), 1)
    } finally {
        f.store.close()
    }
})

test('existing6103 alias counts only after actual successful placement and failed geometry/ownership leaves both source and receipts untouched', () => {
    const f = buildingPlacementFixture('placement-create-compatibility')
    try {
        f.own(30051)
        f.own(50021)
        const before = structuredClone(f.store.load(f.session.id))
        assert.throws(() => f.call('BuildCreate', { build_id: 30051, locate: { block_id: 999999, anchor: 0 } }))
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.throws(() => f.call('BuildLocate', { guid: 999999, build_id: 30051, locate: f.location(30051) }))
        assert.deepEqual(f.store.load(f.session.id), before)
        f.place(30051, 0, 'BuildCreate')
        f.place(50021, 0, 'BuildCreate')
        assert.equal(value(f, decoration), 1)
        assert.equal(value(f, dormitory), 1)
        assert(targets.every((id) => f.state().achievements.entries[id].finishTime > 0))
    } finally {
        f.store.close()
    }
})

test('first placement, withdrawal and9902 response failures roll back owned lists, inventory use and completion in one transaction', () => {
    const f = buildingPlacementFixture('placement-codec-rollback')
    const encode = f.protocol.encode
    const fail = (wire, operation) => {
        const type = f.protocol.byName.get(wire).rsp
        const shared = f.state(),
            before = structuredClone(f.store.load(f.session.id))
        let hit = false
        f.protocol.encode = function (name, ...args) {
            if (name === type) {
                hit = true
                throw Error('placement-codec-failure')
            }
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(operation, /placement-codec-failure/)
            assert(hit)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(shared, before.state)
    }
    try {
        f.own(30051)
        for (const wire of ['CSProtoHomeSync', 'CSProtoBuildLocate', 'CSProtoAchievementSync'])
            fail(wire, () => f.place(30051))
        assert.equal(value(f, decoration), 0)
        assert(!f.state().achievements.entries[2010009])
        const placed = f.place(30051).build
        for (const wire of ['CSProtoHomeSync', 'CSProtoBuildUnlocate'])
            fail(wire, () => f.call('BuildUnlocate', { guid: placed.guid }))
        fail('CSProtoAchievementReward', () => f.call('AchievementReward', { u32: 2010009 }))
        assert.equal(value(f, decoration), 1)
        assert.equal(f.state().achievements.entries[2010009].claimed, false)
        f.call('AchievementReward', { u32: 2010009 })
        assert(f.state().achievements.entries[2010009].claimed)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('login observes existing synced placement without astatus1 filter; file reopen, withdrawal and another account preserve the proper scope', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-placement-progress-'))
    let f
    try {
        const file = path.join(directory, 'state.sqlite')
        f = buildingPlacementFixture('placement-persistent', file)
        f.own(30051)
        f.own(50021)
        const a = f.place(30051).build,
            b = f.place(50021).build
        // Simulate a legitimate imported placed source whose achievement
        // consumer had never observed it; do not claim a current status2/3 timer.
        f.edit((s) => {
            s.home.builds.find((row) => row.guid === a.guid).status = 2
            s.home.builds.find((row) => row.guid === b.guid).status = 3
            for (const id of targets) delete s.achievements.entries[id]
        })
        f.store.close()
        f = buildingPlacementFixture('placement-persistent', file)
        assert(targets.every((id) => f.state().achievements.entries[id].finishTime > 0))
        assert.equal(value(f, decoration), 1)
        assert.equal(value(f, dormitory), 1)
        f.advance(10000)
        f.game.tick(f.session.id)
        assert.equal(f.state().home.builds.find((row) => row.guid === a.guid).status, 2)
        assert.equal(f.state().home.builds.find((row) => row.guid === b.guid).status, 3)
        f.edit((s) => {
            for (const row of s.home.builds) if ([a.guid, b.guid].includes(row.guid)) row.status = 1
        })
        for (const id of targets) f.call('AchievementReward', { u32: id })
        f.call('BuildUnlocate', { guid: a.guid })
        f.call('BuildUnlocate', { guid: b.guid })
        f.store.close()
        f = buildingPlacementFixture('placement-persistent', file)
        assert.equal(value(f, decoration), 0)
        assert.equal(value(f, dormitory), 0)
        assert(targets.every((id) => f.state().achievements.entries[id].claimed))
        const points = achievementPoints(f.tables, f.state())
        for (const id of targets) f.call('AchievementReward', { u32: id })
        assert.equal(achievementPoints(f.tables, f.state()), points)
        const other = {}
        f.call('EnterGame', { open_id: 'placement-other' }, other)
        assert.equal(buildingPlacementValue(f.tables, f.store.load(other.id).state, decoration), 0)
        assert.equal(buildingPlacementValue(f.tables, f.store.load(other.id).state, dormitory), 0)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-placement-progress-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
