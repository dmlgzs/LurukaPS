import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer, heroData } from '../src/player.js'
import {
    currentHeroAvailable,
    projectCurrentHeroes,
    suspendUnavailableHeroFormations,
} from '../src/hero-compatibility.js'
import { heroModules, refreshBattleState } from '../src/battle.js'
import { permanentHeroFavorRecords } from '../src/hero-favor-ownership.js'
import { heroCountProgressValue } from '../src/hero-count-progress.js'
import { currentTaskAvailable, suspendUnavailableTasks } from '../src/task-compatibility.js'
import { taskSnapshot } from '../src/tasks.js'
import { applyRepairVisuals, repairSavedWorldRepairs, isCurrentSavedWorldObject } from '../src/world-repairs.js'

const config = configuration()
function changedTables(name, mutate) {
    const tables = new Tables(config.tables)
    tables.cache.set(name, mutate(structuredClone(tables.get(name))))
    return tables
}

test('known CBT3 hero remains owned with equipment and favor, while current battle and wire use available actors', () => {
    const tables = new Tables(config.tables),
        state = seedPlayer(tables, 1, 'compat')
    const old = { ...heroData(104001, 1), hero_lv: 20, favorability_lv: 8, wguid: 123 }
    const oldPet = state.pets[0]
    oldPet.hero_id = old.guid
    old.pet_id = oldPet.guid
    state.player.heros_info.heros.push(old)
    state.player.heros_info.battle_infos.push({ hero_id: old.guid, hp: 9, sp: 1, alive_state: 0 })
    const group = state.player.group_mgrs[0].groups[0]
    group.heros[0] = { hero_id: old.guid, pet_id: '4321' }
    group.control = old.guid
    const owned = structuredClone(state.player.heros_info.heros),
        groups = structuredClone(state.player.group_mgrs)
    const attributes = refreshBattleState(tables, state)
    assert(!attributes.some((entry) => entry.hero_guid === old.guid))
    assert.deepEqual(state.player.heros_info.heros, owned)
    assert.deepEqual(state.compatibilityDiagnostics.suspendedHeroBattleInfos, [
        { hero_id: old.guid, hp: 9, sp: 1, alive_state: 0 },
    ])
    const player = projectCurrentHeroes(tables, state)
    assert(!player.heros_info.heros.some((entry) => entry.guid === old.guid))
    assert.equal(player.group_mgrs[0].groups[0].control, owned.find((hero) => hero.type === 1).guid)
    assert.deepEqual(state.player.group_mgrs, groups)
    assert.equal(suspendUnavailableHeroFormations(tables, state), true)
    assert.equal(oldPet.hero_id, '0')
    assert.deepEqual(state.compatibilityDiagnostics.suspendedHeroPetBindings[oldPet.guid], { hero_id: old.guid })
    assert.equal(old.pet_id, oldPet.guid)
    assert.deepEqual(state.compatibilityDiagnostics.suspendedHeroFormations['1:1'].group, groups[0].groups[0])
    assert.equal(state.player.group_mgrs[0].groups[0].control, owned.find((hero) => hero.type === 1).guid)
    assert.equal(suspendUnavailableHeroFormations(tables, state), false)
    assert.deepEqual(state.player.heros_info.heros, owned)
    assert.throws(() => heroModules(tables, state, old), /Missing hero row 104001/)
    refreshBattleState(tables, state)
    assert.equal(state.compatibilityDiagnostics.suspendedHeroBattleInfos[0].hp, 9)
    assert(!permanentHeroFavorRecords(tables, state).some((entry) => entry.actor.guid === old.guid))
    assert.equal(
        heroCountProgressValue(tables, state, [12036, 0, 1]),
        owned.filter((hero) => tables.find('hero', hero.conf_id)?.isUsable === 1).length - 1,
    )
    const duplicate = structuredClone(state)
    duplicate.player.heros_info.heros.push(structuredClone(old))
    assert.throws(() => permanentHeroFavorRecords(tables, duplicate), /Duplicate or invalid permanent hero/)
})

test('unknown missing heroes, trial IDs and damaged current hero export are not treated as retired content', () => {
    const tables = new Tables(config.tables)
    assert.equal(currentHeroAvailable(tables, heroData(104001, 1)), false)
    assert.throws(() => currentHeroAvailable(tables, heroData(999991, 1)), /Missing hero row/)
    assert.throws(() => currentHeroAvailable(tables, { ...heroData(104001, 1), trail: true }), /Missing hero row/)
    assert.equal(currentHeroAvailable(tables, { ...heroData(999991, 1), abyss: true }), true)
    const damaged = changedTables('hero', (rows) => rows.filter((row) => row.id !== 101003))
    assert.throws(() => currentHeroAvailable(damaged, heroData(104001, 1)), /Missing hero row/)
    assert.throws(() => currentHeroAvailable(damaged, heroData(101003, 1)), /Missing hero row/)
})

test('claimed missing legacy repair preserves original fact and diagnostic but cannot be repaired live', () => {
    const tables = new Tables(config.tables),
        record = { obj_id: 2610017, complete: true, claims: { repair: { id: 10121, time: 123 } } }
    const state = { worldObjects: { '100:2610017': structuredClone(record) } }
    repairSavedWorldRepairs(tables, state)
    assert.deepEqual(state.worldObjects['100:2610017'], record)
    assert.equal(state.compatibilityDiagnostics.worldRepairs['100:2610017'].reason, 'unavailableCurrentObject')
    assert.equal(isCurrentSavedWorldObject(tables, state, '100:2610017'), false)
    assert.throws(() => applyRepairVisuals(tables, state, 100, 2610017), /Object is not in current map/)
    const damaged = changedTables('worldmap_100', (rows) => rows.filter((row) => row.id !== 902630))
    assert.throws(() => repairSavedWorldRepairs(damaged, structuredClone(state)), /Object is not in current map/)
})

test('current repair roots still reconstruct configured visuals and reject malformed current child/spawner data', () => {
    const state = () => ({ worldObjects: { '100:902630': { obj_id: 902630, claims: { repair: { id: 10110 } } } } })
    const tables = new Tables(config.tables),
        s = state()
    repairSavedWorldRepairs(tables, s)
    assert.equal(s.worldObjects['100:902630'].complete, true)
    assert.equal(s.worldObjects['100:902631'].active, true)
    assert.equal(isCurrentSavedWorldObject(tables, s, '100:902630'), true)
    const damaged = changedTables('worldmap_100', (rows) => rows.filter((row) => row.id !== 902631))
    assert.throws(() => repairSavedWorldRepairs(damaged, state()), /Object is not in current map/)
    const missingSpawner = changedTables('world_spawner', (rows) => rows.filter((row) => row.id !== 8000000))
    assert.throws(() => repairSavedWorldRepairs(missingSpawner, state()), /World spawner missing/)
})

test('historical missing tasks archive full node progress as one source-bounded migration without clearing earned facts', () => {
    const tables = new Tables(config.tables),
        state = seedPlayer(tables, 1, 'task-archive')
    const old = [400111, 206045, 206046, 214002].map((task_id) => ({
        task_id,
        nodes: [{ node_id: 3, node_values: [2], client_before: true }],
        finish_nodes: [1, 2],
        reward_nodes: [2],
        client_trace: true,
    }))
    state.tasks = [...old, { task_id: 106001, nodes: [], finish_nodes: [], reward_nodes: [] }]
    state.taskRecords = [
        { task_id: 214002, count: 1, time: 42 },
        { task_id: 106001, count: 2, time: 43 },
    ]
    state.taskDeliveries = { '214002:0:3:0': { '3:300000': 5 } }
    state.pendingTaskStorySync = { task_id: 214002, node_id: 3, stories: [{ story_id: 100001 }] }
    const records = structuredClone(state.taskRecords),
        deliveries = structuredClone(state.taskDeliveries)
    assert.deepEqual(
        suspendUnavailableTasks(tables, state),
        old.map((task) => task.task_id),
    )
    assert.deepEqual(
        state.tasks.map((task) => task.task_id),
        [106001],
    )
    for (const task of old)
        assert.deepEqual(state.compatibilityDiagnostics.suspendedTasks[`${task.task_id}:0`].task, task)
    assert.deepEqual(state.taskRecords, records)
    assert.deepEqual(state.taskDeliveries, deliveries)
    assert.equal(state.pendingTaskStorySync, undefined)
    const snapshot = taskSnapshot(tables, state)
    assert.deepEqual(snapshot.task_records, records)
    assert.deepEqual(
        snapshot.del_tasks,
        old.map((task) => task.task_id),
    )
    assert.deepEqual(suspendUnavailableTasks(tables, state), [])
    assert.throws(() => currentTaskAvailable(tables, 987654321), /Unknown saved task/)
    const damaged = changedTables('task', (rows) => rows.filter((row) => row.id !== 106001))
    assert.throws(() => currentTaskAvailable(damaged, 214002), /Unknown saved task/)
    assert.throws(() => currentTaskAvailable(damaged, 106001), /Unknown saved task/)
})
