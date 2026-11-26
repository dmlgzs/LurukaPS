import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentGmWorldPoints, unlockCurrentGmWorldPoints } from '../src/gm-world-points.js'
import { ErrorCode } from '../src/error-codes.js'
import { Protocol } from '../src/protocol.js'

const runtime = process.env.GM_POINTS_RUNTIME_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const tableRoot = process.env.LURUKAPS_TABLES ?? path.resolve(runtime, '../Tables/Tables')
const cache = new Map()
function rows(name) {
    if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(path.join(tableRoot, `${name}.json`), 'utf8')))
    return cache.get(name)
}
function tables(overrides = {}) {
    return { get: (name) => overrides[name] ?? rows(name) }
}
function mutated(name, id, change) {
    const result = structuredClone(rows(name))
    const row = result.find((value) => value.id === id)
    assert.ok(row)
    change(row, result)
    return { [name]: result }
}
const configError = (fn, code = ErrorCode.GameConfig) => assert.throws(fn, (error) => error.code === code)

test('current map marker catalogue selects 26 activation entities, not all 1418 birth positions', () => {
    const result = currentGmWorldPoints(tables())
    assert.equal(rows('world_borthpos').length, 1418)
    assert.equal(result.pointIds.length, 26)
    assert.equal(result.bindings.filter((row) => row.locked).length, 24)
    assert.equal(result.bindings.filter((row) => !row.locked).length, 2)
    assert.deepEqual([...new Set(result.bindings.map((row) => row.mapId))].sort(), [100, 101, 200])
    assert.ok(result.pointIds.includes(10050))
    assert.ok(result.pointIds.includes(20005))
    assert.ok(!result.pointIds.includes(10001), 'arbitrary type2 scene birth is excluded')
    assert.ok(!result.pointIds.includes(10101), 'cross-scene Birth1 entrance is not an activation point')
    assert.ok(!result.pointIds.includes(620301), 'task dungeon birth is excluded')
    assert.equal(result.displayOnly.length, 2)
    assert.deepEqual(
        result.displayOnly.map((row) => row.pointId).sort((a, b) => a - b),
        [10101, 20005],
    )
    assert.ok(!result.bindings.some((row) => row.mapId === 6219), 'story clone is not a current map marker')
})

test('catalogue is independent of current table ordering and names', () => {
    const names = [
        'world_filter_mark',
        'world_borthpos',
        'world_spawner',
        'world_city',
        'worldmap_100',
        'worldmap_101',
        'worldmap_200',
    ]
    const overrides = Object.fromEntries(names.map((name) => [name, structuredClone(rows(name)).reverse()]))
    for (const list of Object.values(overrides)) for (const row of list) if ('name' in row) row.name = ''
    assert.deepEqual(currentGmWorldPoints(tables(overrides)), currentGmWorldPoints(tables()))
})

test('GM union preserves historical points, map flag, assets and natural interaction facts', () => {
    const state = {
        world: { points: [620301, 10050, 4294967295], unlockAllMaps: true, map_id: 6203 },
        worldObjects: { '100:200128': { complete: false, claims: {} } },
        bag: [{ id: 10050, count: 5 }],
        tasks: [{ id: 106001, nodeId: 1 }],
    }
    const before = structuredClone(state)
    const first = unlockCurrentGmWorldPoints(tables(), state)
    assert.equal(first.added.length, 25)
    assert.equal(first.points.length, 28)
    assert.ok(first.points.includes(620301) && first.points.includes(4294967295))
    assert.deepEqual({ ...state, world: before.world }, before)
    assert.equal(state.world.unlockAllMaps, true)
    assert.equal(state.world.map_id, 6203)
    assert.ok(!Object.hasOwn(state, 'worldPointRewardRevision'))
    const second = unlockCurrentGmWorldPoints(tables(), state)
    assert.deepEqual(second.added, [])
    assert.deepEqual(second.points, first.points)
    const withoutFlag = { world: { points: [] } }
    unlockCurrentGmWorldPoints(tables(), withoutFlag)
    assert.ok(!Object.hasOwn(withoutFlag.world, 'unlockAllMaps'))
})

test('current 9105 payload roundtrips old and new uint32 IDs without inventing activation request', () => {
    const protocol = new Protocol(runtime)
    const sync = protocol.byName.get('CSProtoWorldMapPointSync')
    assert.equal(sync.id, 9105)
    assert.equal(protocol.byName.get('CSProtoWorldObjInteract').id, 9133)
    assert.equal(protocol.byName.get('CSProtoSimpleProductCancel').id, 11011)
    const state = { world: { points: [4294967295] } }
    const result = unlockCurrentGmWorldPoints(tables(), state)
    const decoded = protocol.decode(sync.rsp, protocol.encode(sync.rsp, { u32s: result.points }))
    assert.deepEqual(decoded.u32s, result.points)
})

test('missing point, object, spawner and city sources reject before any state write', () => {
    const sources = [
        [
            mutated('world_filter_mark', 1000001, (row) => {
                row.posId = 4294967295
            }),
            ErrorCode.NotFoundBirthPoint,
        ],
        [
            mutated('world_filter_mark', 1000001, (row) => {
                row.worldmapId = 4294967295
            }),
            ErrorCode.GameConfig,
        ],
        [
            mutated('worldmap_100', 200128, (row) => {
                row.spawnerId = 4294967295
            }),
            ErrorCode.SpawnerConfIsNull,
        ],
        [
            mutated('world_borthpos', 10050, (row) => {
                row.cityId = 4294967295
            }),
            ErrorCode.NoWorldCityConf,
        ],
    ]
    for (const [override, code] of sources) {
        const state = { world: { points: [10001], unlockAllMaps: true } }
        const oldReference = state.world.points
        configError(() => unlockCurrentGmWorldPoints(tables(override), state), code)
        assert.strictEqual(state.world.points, oldReference)
        assert.deepEqual(state, { world: { points: [10001], unlockAllMaps: true } })
    }
})

test('duplicate identities and damaged activation cross-bindings are strict configuration errors', () => {
    const changes = [
        mutated('world_filter_mark', 1000001, (row, list) => list.push(structuredClone(row))),
        mutated('worldmap_100', 200128, (row, list) => list.push(structuredClone(row))),
        mutated('worldmap_100', 200128, (row) => {
            row.expandId = 10051
        }),
        mutated('worldmap_100', 200128, (row) => {
            row.filterMark = 1000002
        }),
        mutated('world_borthpos', 10050, (row) => {
            row.type = 1
        }),
        mutated('world_borthpos', 10050, (row) => {
            row.lockPoint = '1'
        }),
        mutated('world_borthpos', 10050, (row) => {
            row.borthPoint = '1|2|NaN|0|0|0'
        }),
        mutated('world_filter_mark', 1000001, (row) => {
            row.icon = ''
        }),
    ]
    for (const override of changes) configError(() => currentGmWorldPoints(tables(override)))
    configError(
        () =>
            currentGmWorldPoints(
                tables(
                    mutated('world_spawner', 26004, (row) => {
                        row.objectType = 22
                    }),
                ),
            ),
        ErrorCode.FunctionClosed,
    )
})

test('malformed saved points are not silently filtered or coerced by the GM helper', () => {
    for (const points of [undefined, {}, [0], [-1], ['10050'], [4294967296]]) {
        const state = { world: { points } }
        const oldReference = state.world.points
        configError(() => unlockCurrentGmWorldPoints(tables(), state))
        assert.strictEqual(state.world.points, oldReference)
    }
})
