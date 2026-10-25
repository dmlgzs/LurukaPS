import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { worldCollectionProgressFixture } from './world-collection-progress-fixture.js'
import { journeyModel, journeyValue, observeJourney } from '../src/journey.js'
import { resourceBuildingProgressRule, resourceBuildingProgressValue } from '../src/resource-building-progress.js'
import { ErrorCode } from '../src/error-codes.js'
const targets = [2030001, 2030010, 2030015],
    collects = [2, 37, 38]
const value = (f, id) => journeyValue(f.tables, f.state(), journeyModel(f.tables).byTarget.get(id))
test('complete12016 three-target family validates actual scene,area inclusion and unique group while preserving overlapping101003 and101001', () => {
    const f = worldCollectionProgressFixture('resource-building-contract')
    try {
        const model = journeyModel(f.tables),
            rows = model.byKind.get(12016)
        assert.equal(rows.length, 3)
        assert(rows.every((r) => r.supported && journeyValue(f.tables, f.state(), r) === 0))
        assert.equal(model.targets.filter((r) => r.supported).length, 162)
        assert.equal(model.referencedTargets.filter((r) => r.supported).length, 146)
        for (const tokens of [
            [12016, 100, 100004, 32101, 1],
            [12016, 101, 101003, 32101, 1],
            [12016, 101, 100004, 32101, 1],
            [12016, 0, 0, 0, 1],
            [12016, 101, 101003, 32301, 2],
        ])
            assert.equal(resourceBuildingProgressRule(f.tables, tokens), false)
        assert.equal(
            resourceBuildingProgressRule(f.tables, [12016, 101, 101001, 32301, 1]),
            true,
            'Do not invent exclusive area ownership for overlapping collect38',
        )
        const state = structuredClone(f.state())
        state.mineralLevel = 999
        state.home.miningLevel = 999
        assert.equal(resourceBuildingProgressValue(f.tables, state, rows[0].tokens), 0)
        state.journey.targets[targets[0]] = { value: 1, complete: false, claimed: false }
        observeJourney(f.tables, state, [12016])
        assert.equal(state.journey.targets[targets[0]].value, 0)
        const before = structuredClone(state)
        resourceBuildingProgressValue(f.tables, state, rows[0].tokens)
        assert.deepEqual(state, before)
        for (const worldCollections of [
            null,
            { '02': { collect_id: 2, build_id: 3110101, guid: 1 } },
            { 2: { collect_id: 37, build_id: 3110101, guid: 1 } },
            { 2: { collect_id: 2, build_id: 3210101, guid: 1 } },
        ])
            assert.throws(
                () => resourceBuildingProgressValue(f.tables, { home: { worldCollections } }, rows[0].tokens),
                (e) => e.code === ErrorCode.GameConfig,
            )
        assert.equal(
            resourceBuildingProgressValue(
                f.tables,
                { home: { worldCollections: { 2: { collect_id: 2, build_id: 0 } } } },
                rows[0].tokens,
            ),
            0,
        )
        for (const guid of [undefined, 4294967296, '18446744073709551615'])
            assert.equal(
                resourceBuildingProgressValue(
                    f.tables,
                    { home: { worldCollections: { 2: { collect_id: 2, build_id: 3110101, guid } } } },
                    rows[0].tokens,
                ),
                1,
                'GUID is not an unlock location predicate',
            )
        // Current fresh collection configuration has only level1. This is an
        // explicit future/legacy configured-level compatibility probe,not an
        // invented live upgrade producer or a completed gameplay receipt.
        const upperLevel = {
            get: (name) =>
                name === 'home_building_collection'
                    ? [...f.tables.get(name), { id: 3110102, groupId: 31101, level: 2 }]
                    : f.tables.get(name),
        }
        assert.equal(
            resourceBuildingProgressValue(
                upperLevel,
                { home: { worldCollections: { 2: { collect_id: 2, build_id: 3110102 } } } },
                rows[0].tokens,
            ),
            1,
        )
        const wrongGroup = {
            get: (name) =>
                name === 'home_building_collection'
                    ? [...f.tables.get(name), { id: 3110102, groupId: 32101, level: 2 }]
                    : f.tables.get(name),
        }
        assert.throws(
            () =>
                resourceBuildingProgressValue(
                    wrongGroup,
                    { home: { worldCollections: { 2: { collect_id: 2, build_id: 3110102 } } } },
                    rows[0].tokens,
                ),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})
test('actual6526 wrong collection does not satisfy targets;three configured repairs complete individually and real homeRevision wakes deferred ordinary observation', () => {
    const f = worldCollectionProgressFixture('resource-building-three-real')
    try {
        f.repair(1)
        assert(targets.every((id) => value(f, id) === 0))
        for (let i = 0; i < collects.length; i++) {
            // Full old nonterminal value is not itself evidence; the real repair
            // still has to create the authoritative configured instance.
            f.edit((s) => (s.journey.targets[targets[i]] = { value: 1, complete: false, claimed: false }))
            const packets = f.repair(collects[i])
            assert(packets.some((p) => p.id === 11880))
            assert.equal(value(f, targets[i]), 1)
            assert.equal(f.state().journey.targets[targets[i]].complete, true)
            for (let j = i + 1; j < targets.length; j++) assert.equal(value(f, targets[j]), 0)
        }
        const before = f.state()
        f.repair(2)
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.journey.targets[targets[0]] = { value: 0, complete: false, claimed: false }
            s.journey.observedSources.home = s.homeRevision - 1
        })
        assert(f.call('ActivityGet').some((p) => p.id === 11880))
        assert.equal(f.state().journey.targets[targets[0]].complete, true)
    } finally {
        f.store.close()
    }
})
test('real6526 source and journey completion roll back on sync,ACK andSQLite failures;actual rewards preserve gates and retry once', () => {
    const f = worldCollectionProgressFixture('resource-building-atomic')
    try {
        const encode = f.protocol.encode,
            before = f.state()
        for (const type of ['SCJourneySync', 'ProtoNullRsp']) {
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('resource-building-encode')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.repair(2), /resource-building-encode/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_resource_repair BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'resource-building-sql'); END",
        )
        assert.throws(() => f.repair(2), /resource-building-sql/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER reject_resource_repair')
        for (const id of collects) f.repair(id)
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [30001] }),
            (e) => e.code === ErrorCode.JourneyTypeLock,
        )
        // Isolate unrelated prerequisite receipts solely for reward-path checks.
        //12096 evaluates target completion recursively,not a task receipt alone.
        // Never import any12016 target or reconstructed collection unlock.
        f.edit((s) => {
            const model = journeyModel(f.tables),
                seen = new Set(),
                protectedTasks = new Set(targets.map((id) => model.owner.get(id)))
            const completeOther = (id) => {
                if (seen.has(id)) return
                seen.add(id)
                const row = model.byTask.get(id)
                assert(row)
                for (const rule of [...row.unlockRules, ...model.tabById.get(row.tabId).unlockRules]) {
                    const [kind, previous] = rule
                    if (kind === 12096 || kind === 12098) {
                        completeOther(previous)
                        if (kind === 12098) assert(s.journey.tasks[previous]?.claimed)
                    } else if (kind === 2004) assert(s.player.basic_info.lv >= previous)
                    else throw Error('Unisolated prerequisite:' + rule.join('#'))
                }
                for (const targetId of row.ids) {
                    const target = model.byTarget.get(targetId)
                    if (target.tokens[0] === 12016) assert(s.journey.targets[targetId]?.complete)
                    else s.journey.targets[targetId] = { value: target.targetParam, complete: true, claimed: true }
                }
                if (!protectedTasks.has(id)) s.journey.tasks[id] = { complete: true, claimed: true }
            }
            for (const id of [20000, 20301, 30009]) completeOther(id)
            s.journey.claimRevision++
        })
        const saved = f.state()
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'Rewards') throw Error('resource-building-reward')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call('JourneyTaskFinish', { u32s: [30001, 30010, 30015] }), /resource-building-reward/)
        assert.deepEqual(f.state(), saved)
        f.protocol.encode = encode
        f.call('JourneyTaskFinish', { u32s: [30001, 30010, 30015] })
        assert(targets.every((id) => f.state().journey.targets[id].claimed))
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [30001, 30010, 30015] }), 9869).rewards, [])
    } finally {
        f.store.close()
    }
})
test('retained real repairs survive SQLite reopen andanother account cannot borrow configured unlocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-building-')),
        file = path.join(dir, 'state.sqlite')
    let f = worldCollectionProgressFixture('resource-building-file', file)
    try {
        for (const id of collects) f.repair(id)
        const saved = structuredClone(f.state().home.worldCollections)
        f.store.close()
        f = worldCollectionProgressFixture('resource-building-file', file)
        assert.deepEqual(f.state().home.worldCollections, saved)
        assert(targets.every((id) => value(f, id) === 1))
        const other = worldCollectionProgressFixture('resource-building-file-other', file)
        try {
            assert(targets.every((id) => value(other, id) === 0))
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
        assert(path.basename(resolved).startsWith('resource-building-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
