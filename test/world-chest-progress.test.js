import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { isFieldChest, worldChestsOpened } from '../src/world-chest-progress.js'
import { battlePassTaskSnapshot, battlePassTaskModel } from '../src/battle-pass-tasks.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
    assert(chests.length >= 10)
    f.store.transact(f.session.id, 0, (s) => {
        s.world.map_id = 101
    })
    const edit = (fn) => f.store.transact(f.session.id, 0, fn),
        open = (id, complete = true, state_data = {}) => {
            edit((s) => {
                s.world.pos = catalog.object(101, id).pos
            })
            return f.call('WorldObjInteract', {
                objs: [{ obj: { obj_id: id, complete, state_data }, interact_type: 0 }],
            })
        }
    return { ...f, catalog, edit, open, chests, chest: chests[0].id }
}

test('only actual named chest types in current field maps classify; a chest model, generic item or dungeon is insufficient', () => {
    const f = fixture('chest-classification')
    try {
        for (const objectType of [18, 30, 32, 33, 34, 35]) assert(isFieldChest(f.tables, 101, { objectType }))
        for (const objectType of [3, 12, 13, 14, 31, 52, 101]) assert(!isFieldChest(f.tables, 101, { objectType }))
        for (const map of [102, 701, 6203, 6557]) assert(!isFieldChest(f.tables, map, { objectType: 32 }))
        assert(!isFieldChest(f.tables, 101, f.catalog.find('world_spawner', 40108)))
    } finally {
        f.store.close()
    }
})

test('lifetime and current-period counts survive real SQLite reopen without paying or counting the saved chest again', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-world-chest-')),
        file = path.join(directory, 'chest.sqlite')
    let f
    try {
        f = fixture('chest-progress-persist', file)
        f.open(f.chest)
        assert.equal(f.state().worldChestHistory.total, 1)
        f.store.close()
        f = null
        f = fixture('chest-progress-persist', file)
        assert.equal(f.state().worldChestHistory.total, 1)
        assert.equal(f.state().dailyActive.week.counts[12072], 1)
        const bag = structuredClone(f.state().player.sbag_infos)
        f.open(f.chest)
        assert.equal(f.state().worldChestHistory.total, 1)
        assert.equal(f.state().dailyActive.week.counts[12072], 1)
        assert.deepEqual(f.state().player.sbag_infos, bag)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('luruka-world-chest-'))
        for (const suffix of ['', '-wal', '-shm', '-journal'])
            if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix)
        fs.rmdirSync(directory)
    }
})

test('a real typed chest counts only its final claim; stage rewards and duplicate/full retries never create another event', () => {
    const f = fixture('chest-final-claim')
    try {
        assert(isFieldChest(f.tables, 101, f.catalog.object(101, f.chest).spawner))
        f.open(f.chest, false, { step: 1, complete: true })
        assert.equal(f.state().dailyActive.week.counts[12072] ?? 0, 0)
        assert.equal(f.state().worldChestHistory?.total ?? 0, 0)
        f.open(f.chest)
        assert.equal(f.state().dailyActive.week.counts[12072], 1)
        assert.equal(f.state().worldChestHistory.total, 1)
        const before = structuredClone(f.state())
        f.open(f.chest)
        assert.equal(f.state().dailyActive.week.counts[12072], 1)
        assert.equal(f.state().worldChestHistory.total, 1)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        f.open(500171) // actual collecting node, not a chest.
        f.open(300040) // PetPuzzleAttrItem161 is not proven by a treasure drop alone.
        assert.equal(f.state().dailyActive.week.counts[12072], 1)
        assert.equal(f.state().worldChestHistory.total, 1)
    } finally {
        f.store.close()
    }
})

test('ten distinct actual field chest claims complete weekly1007 and battle-pass progress without today-history backfill', () => {
    const f = fixture('chest-weekly-producer')
    try {
        const candidates = f.chests.slice(0, 10)
        assert.equal(candidates.length, 10)
        for (const row of candidates) f.open(row.id)
        assert.equal(f.state().dailyActive.week.counts[12072], 10)
        assert.equal(f.state().worldChestHistory.total, 10)
        const bp = battlePassTaskSnapshot(f.tables, f.state(), 1800000000)
        // The actual event is also handed to the existing battle-pass recorder;
        // inspect the current season's canonical counters, not seeded progress.
        const season = f.state().battlePass.seasons[f.state().battlePass.activeKey]
        assert(Object.values(season.tasks).some((period) => period?.counts?.[12072] > 0))
        const wire = [...bp.day_task, ...bp.week_task, ...bp.forever_task],
            visible = battlePassTaskModel(f.tables)
                .byEventKind.get(12072)
                .filter((row) => wire.some((task) => task.task_id === row.id))
        assert(visible.length > 0)
        for (const row of visible)
            assert.equal(wire.find((task) => task.task_id === row.id).curr_count, Math.min(10, row.param))
        f.call('GetActiveReward', { u32s: [1007] })
        const active = f.state().dailyActive.week.active
        assert(active > 0)
        f.call('GetActiveReward', { u32s: [1007] })
        assert.equal(f.state().dailyActive.week.active, active)
        f.game.clock = () => 1800000000 + 8 * 86400
        f.call('ActivityGet')
        f.open(candidates[0].id)
        assert.equal(f.state().dailyActive.week.counts[12072] ?? 0, 0)
        assert.equal(f.state().worldChestHistory.total, 10)
    } finally {
        f.store.close()
    }
})

test('confirmed old static claim receipts migrate lifetime only; initial state and ordinary objects are not history', () => {
    const f = fixture('chest-historical-receipts')
    try {
        const state = f.state()
        delete state.worldChestHistory
        state.worldObjects = {
            ['101:' + f.chest]: { obj_id: f.chest, complete: true, claims: { complete: true }, time: 1 },
            '101:500171': { obj_id: 500171, complete: true, claims: { complete: true }, time: 1 },
            '101:300041': { obj_id: 300041, complete: true },
            '101:999999999': { obj_id: 999999999, complete: true, claims: { complete: true } },
        }
        const weekly = structuredClone(state.dailyActive)
        assert.equal(worldChestsOpened(f.tables, state), 1)
        assert.deepEqual(state.dailyActive, weekly)
        // Steady reads use the verified aggregate instead of rescanning old
        // records. A later new claim goes through the actual producer.
        state.worldObjects = new Proxy(
            {},
            {
                ownKeys() {
                    assert.fail('repeated migration')
                },
            },
        )
        assert.equal(worldChestsOpened(f.tables, state), 1)
    } finally {
        f.store.close()
    }
})

test('invalid history, a later invalid object or actual9133 encoding failure rolls back loot and every chest counter', () => {
    const f = fixture('chest-progress-rollback')
    try {
        f.edit((s) => {
            s.world.pos = f.catalog.object(101, f.chest).pos
        })
        const request = { objs: [{ obj: { obj_id: f.chest, complete: true }, interact_type: 0 }] },
            before = structuredClone(f.state()),
            original = f.protocol.encode,
            responseType = f.protocol.byName.get('CSProtoWorldObjInteract').rsp
        assert.throws(() =>
            f.call('WorldObjInteract', { objs: [...request.objs, { obj: { obj_id: 0xffffffff, complete: true } }] }),
        )
        assert.deepEqual(f.state(), before)
        f.protocol.encode = function (name, ...args) {
            if (name === responseType) throw Error('chest9133 packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('WorldObjInteract', request), /chest9133 packet fault/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = original
        f.edit((s) => {
            s.worldChestHistory = { version: 1, total: -1 }
        })
        const invalid = structuredClone(f.state())
        assert.throws(
            () => f.call('WorldObjInteract', request),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), invalid)
    } finally {
        f.store.close()
    }
})
