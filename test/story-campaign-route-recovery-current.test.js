import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { recoverStoryCampaignClear } from '../src/handlers/story-campaign.js'

const tables = new Tables(configuration().tables)

test('raw first-scene deaths never recover a route clear without an active complete current attempt', () => {
    const state = {
        tasks: [{ task_id: 106014, nodes: [{ node_id: 11 }] }],
        world: { map_id: 100 },
        worldObjects: {},
    }
    for (const row of tables.get('worldmap_6200').filter((row) => row.spawnerId === 99016)) {
        const slots = String(tables.find('world_enemy_group', row.expandId).enemyList).split('|')
        state.worldObjects['6200:' + row.id] = {
            complete: true,
            state_data: { step: 1 },
            expand_data: { battle_group: { monsters: slots.map(() => ({ hp: 0 })) } },
        }
    }
    const attempt = {
        dungeon_id: 10010,
        group_id: 200,
        difficulty: 1,
        status: 2,
        map_id: 6200,
        scenes: [6200, 6201],
        completed_scenes: [6200],
    }
    for (const run of [
        undefined,
        attempt,
        { ...attempt, status: 4 },
        { ...attempt, scenes: [6200] },
        { ...attempt, map_id: 6201, completed_scenes: [6201] },
    ]) {
        state.storyCampaign = run
        const before = structuredClone(state)
        assert.equal(recoverStoryCampaignClear({ state, tables, now: 1800000000 }), false)
        assert.deepEqual(state, before)
    }
})

test('previously awarded clears remain untouched even if an old route is incomplete', () => {
    const state = { storyCampaignClears: { 10010: { count: 1, time: 123 } } }
    const before = structuredClone(state)
    assert.equal(recoverStoryCampaignClear({ state, tables, now: 1800000000 }), false)
    assert.deepEqual(state, before)
})
