import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'current-weekly-story-pure-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(logs, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(logs, 'reward-source.jsonl')
const [{ configuration }, { Tables }, { EntrustCatalog }, { currentWeeklyStoryPlan }, story, { ErrorCode }] =
    await Promise.all([
        import('../src/config.js'),
        import('../src/player.js'),
        import('../src/entrust.js'),
        import('../src/current-weekly-story.js'),
        import('../src/multiple-material-story.js'),
        import('../src/error-codes.js'),
    ])
const tables = new Tables(configuration().tables)
const contract = JSON.parse(fs.readFileSync(new URL('../configs/current-weekly-intro.json', import.meta.url), 'utf8'))
const runFor = (profile) => ({
    kind: 'weekly',
    entrust_id: profile.weekly_id,
    dungeon_id: profile.dungeon_id,
    map_id: profile.map_id,
})
const profile = (id) => contract.profiles.find((row) => row.weekly_id === id)
const tableView = (table, changed) => ({
    dir: tables.dir,
    get: (name) => (name === table ? changed : tables.get(name)),
    find(name, id) {
        return this.get(name).find((row) => row.id === Number(id))
    },
    position: tables.position.bind(tables),
})
const configError = (error) => error.code === ErrorCode.GameConfig

test('all18 current weekly intro plans bind current source and retain exact3topologies including357 pointtype1', () => {
    assert.equal(contract.profiles.length, 18)
    const before = JSON.stringify(contract),
        seen = new Set()
    for (const p of contract.profiles) {
        const run = runFor(p),
            snapshot = structuredClone(run),
            plan = currentWeeklyStoryPlan(tables, run, contract)
        assert.deepEqual(plan, p.plan)
        assert.deepEqual(run, snapshot)
        seen.add(p.blueprint_id)
        assert.equal(story.materialStoryPlan(tables, run).story_id, plan.story_id)
    }
    assert.deepEqual([...seen].sort(), [300357, 300358])
    assert.equal(currentWeeklyStoryPlan(tables, runFor(profile(101)), contract).story_id, 6110002)
    assert.equal(currentWeeklyStoryPlan(tables, runFor(profile(201)), contract).story_id, 6110010)
    assert.equal(currentWeeklyStoryPlan(tables, runFor(profile(301)), contract).story_id, 6110008)
    assert.equal(tables.find('world_borthpos', profile(301).plan.point_id).type, 1)
    assert.equal(JSON.stringify(contract), before, 'source/contract validation does not mutate external data')
})

test('weekly cache cannot accept same-map wrong difficulty,dungeon or unknown route and never falls back tozeroGuard', () => {
    const p = profile(101),
        r = runFor(p)
    currentWeeklyStoryPlan(tables, r, contract)
    for (const bad of [
        { ...r, entrust_id: 102 },
        { ...r, dungeon_id: 1 },
        { ...r, map_id: 6375 },
        { ...r, entrust_id: 999999 },
    ])
        assert.throws(
            () => currentWeeklyStoryPlan(tables, bad, contract),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
    const changed = structuredClone(contract)
    changed.model = { mode: 'serial-present-wait-tags-with-explicit-auto-anchors', bossTag: 0 }
    assert.throws(() => currentWeeklyStoryPlan(tables, r, changed), configError)
})

test('source,model,profile range and compiled row claims cannot be rewritten to self-authorize', () => {
    const run = runFor(profile(101))
    for (const mutate of [
        (value) => {
            value.sourceFingerprint = '0'.repeat(64)
        },
        (value) => {
            value.source.server351 = { graphSha256: '0'.repeat(64) }
        },
        (value) => {
            value.model.branch = 'False'
        },
        (value) => {
            value.profiles[0].plan.range *= 10000
        },
        (value) => {
            value.profiles[0].tableFingerprints = {}
        },
    ]) {
        const changed = structuredClone(contract)
        mutate(changed)
        assert.throws(() => currentWeeklyStoryPlan(tables, run, changed), configError)
    }
    const version = structuredClone(contract)
    version.packageVersion = '2302423'
    assert.throws(
        () => currentWeeklyStoryPlan(tables, run, version),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
})

test('current table row mutation and warmed-cache length drift fail without changing source tables', () => {
    const p = profile(101),
        run = runFor(p)
    for (const [name, id, mutate] of [
        [
            'dungeon_scene',
            p.scene_id,
            (row) => {
                row.serverBlueprintId = 0
            },
        ],
        [
            'world_borthpos',
            p.plan.point_id,
            (row) => {
                row.cityId = 100
            },
        ],
        [
            'world_interact',
            p.plan.local_trigger_source.interact_id,
            (row) => {
                row.interactRange = 999999
            },
        ],
        [
            'worldmap_' + p.map_id,
            p.plan.boss_id,
            (row) => {
                row.expandId = 1
            },
        ],
    ]) {
        const rows = structuredClone(tables.get(name)),
            view = tableView(name, rows)
        currentWeeklyStoryPlan(view, run, contract)
        mutate(rows.find((row) => row.id === id))
        assert.throws(() => currentWeeklyStoryPlan(view, run, contract), configError)
    }
    const name = 'worldmap_' + p.map_id,
        rows = structuredClone(tables.get(name)),
        view = tableView(name, rows)
    currentWeeklyStoryPlan(view, run, contract)
    rows.push({ ...rows[0] })
    assert.throws(() => currentWeeklyStoryPlan(view, run, contract), configError)
})

test('genuine global END guards remain per-instance,connection,participant andexactstory;357 local record is notglobalEND', () => {
    const run = { ...runFor(profile(301)), instance_id: 7, status: 2, stage_index: 1, loading_complete_at: 1795695240 },
        plan = currentWeeklyStoryPlan(tables, run, contract)
    const c = {
        tables,
        state: { world: { map_id: run.map_id, pos: { ...plan.pos } }, entrust: { run } },
        id: 1,
        now: 1795695240,
        combatSessionId: 'unit-current-connection',
    }
    assert.equal(story.prepareMaterialStory(c), true)
    assert.equal(run.materialStory.phase, 'await_trigger')
    assert.equal(story.beginMaterialStory(c, plan.trigger_id), true)
    assert.equal(run.materialStory.phase, 'playing')
    assert.equal(
        story.materialStoryStartPayload(run.materialStory).start_time,
        c.now,
        'story time remains Unix seconds',
    )
    const before = structuredClone(run)
    assert.throws(
        () => story.finishMaterialStory(c, { story_id: 101571, op: 1 }),
        (error) => error.code === ErrorCode.InvalidArgument,
    )
    assert.deepEqual(run, before)
    assert.throws(
        () => story.finishMaterialStory(c, { story_id: plan.story_id, op: 2 }),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
    c.combatSessionId = 'other-current-connection'
    assert.throws(
        () => story.finishMaterialStory(c, { story_id: plan.story_id, op: 1 }),
        (error) => error.code === ErrorCode.InvalidLogic,
    )
    c.combatSessionId = 'unit-current-connection'
    run.materialStory.participants.push(2)
    assert.throws(
        () => story.finishMaterialStory(c, { story_id: plan.story_id, op: 1 }),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
    run.materialStory.participants.pop()
    assert.equal(story.finishMaterialStory(c, { story_id: plan.story_id, op: 1 }), true)
    assert.equal(run.materialStory.phase, 'done')
    assert.equal(run.battle_start_time, c.now)
    assert.equal(story.finishMaterialStory(c, { story_id: plan.story_id, op: 1 }), false)
})

test('nonweekly material current92 plan results keep existing no-intro behavior and are notpromoted byweekly capability', () => {
    const catalog = new EntrustCatalog(tables)
    for (const material of tables.get('dungeon_material')) {
        const route = catalog.get(material.id, 'material')
        assert.equal(
            story.materialStoryPlan(tables, {
                kind: 'material',
                entrust_id: material.id,
                dungeon_id: material.dungeonId,
                map_id: route.scene.id,
            }),
            null,
        )
    }
    assert.equal(story.materialStoryPlan(tables, { kind: 'entrust', map_id: 6904 }), null)
})
