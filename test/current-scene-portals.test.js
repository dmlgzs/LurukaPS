import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { currentScenePortalRoute } from './current-scene-portals.js'

const tables = new Tables(configuration().tables)
const state = (map) => ({
    world: { map_id: map },
    player: { basic_info: { lv: 15 } },
    taskRecords: [{ task_id: 106001, count: 1 }],
})

test('current portal routes distinguish repeated origin IDs and destination NPC markers without inventing transfers', () => {
    const input = state(250),
        before = structuredClone(input)
    const route = currentScenePortalRoute(tables, input, 701)
    assert.deepEqual(
        route.map(({ from, to, object, point }) => ({ from, to, object, point })),
        [
            { from: 250, to: 200, object: 200000, point: 20002 },
            { from: 200, to: 701, object: 600388, point: 70101 },
        ],
    )
    assert(
        route.every((edge) => edge.object !== 400001),
        '701 hint400001 is an NPC,not a door',
    )
    assert.deepEqual(input, before)
    assert.deepEqual(
        currentScenePortalRoute(tables, state(100), 250).map((edge) => edge.object),
        [200010, 200000],
    )
    assert.deepEqual(
        currentScenePortalRoute(tables, state(701), 100).map((edge) => edge.object),
        [200001, 200002],
    )
    assert.throws(() => currentScenePortalRoute(tables, state(100), 6200), /Unqualified/)
})

test('unmet appearance,fulfilled disappearance and unknown portal conditions never become legal paths', () => {
    const override = (change) => ({
        dir: tables.dir,
        get(name) {
            const rows = tables.get(name)
            return name === 'worldmap_200' ? rows.map((row) => (row.id === 600388 ? { ...row, ...change } : row)) : rows
        },
        find: (name, id) => tables.find(name, id),
    })
    const input = state(250)
    for (const change of [{ appearCond: '2004#25' }, { disappearCond: '2007#106001' }, { appearCond: '999999#1' }])
        assert.throws(() => currentScenePortalRoute(override(change), input, 701), /No qualified/)
    assert.equal(currentScenePortalRoute(override({ appearCond: '2004#15' }), input, 701).at(-1).object, 600388)
})
