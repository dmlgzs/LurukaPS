import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { activateWorldPoint, resolveWorldPointActivation } from '../src/world-point-activation.js'
import { ErrorCode } from '../src/error-codes.js'
import { naturalPointFixture, pointSource, pointCheckpoint } from './world-point-activation-current-fixture.js'

const tables = new Tables(configuration().tables)
const errorCode = (fn, code) => assert.throws(fn, (error) => error.code === code)
const modified = (name, id, change) => {
    const rows = structuredClone(tables.get(name))
    change(
        rows.find((value) => value.id === id),
        rows,
    )
    return {
        get: (key) => (key === name ? rows : tables.get(key)),
        find: (key, keyId) => (key === name ? rows : tables.get(key)).find((value) => value.id === Number(keyId)),
    }
}

test('pure current main and secondary source bindings grant one real point record, not rewards or map permission', () => {
    for (const [objectId, pointId, actionId] of [
        [200128, 10050, 13],
        [201037, 1001453, 136],
    ]) {
        const state = pointCheckpoint(tables, objectId)
        state.world.points = [10001]
        const source = pointSource(tables, objectId)
        const activation = activateWorldPoint(tables, state, source.row, source.spawner, source.request.objs[0])
        assert.equal(activation.pointId, pointId)
        assert.equal(activation.actionId, actionId)
        assert.equal(activation.added, true)
        assert.deepEqual(
            state.world.points,
            [10001, pointId].sort((a, b) => a - b),
        )
        assert.equal(state.worldPointRewardRevision, 1)
        assert.equal(state.world.unlockAllMaps, undefined)
        assert.equal(state.player.sbag_infos, undefined)
        assert.equal(state.worldObjects, undefined)
        const repeated = activateWorldPoint(tables, state, source.row, source.spawner, source.request.objs[0])
        assert.equal(repeated.added, false)
        assert.equal(state.worldPointRewardRevision, 1)
    }
})

test('pure current system151 reads true185 facts, including current-attempt precedence over old completion', () => {
    const source = pointSource(tables)
    for (const state of [
        { ...pointCheckpoint(tables), tasks: [] },
        {
            ...pointCheckpoint(tables),
            tasks: [{ task_id: 106010, finish_nodes: [] }],
            taskRecords: [{ task_id: 106010, count: 1 }],
        },
    ]) {
        const before = structuredClone(state)
        errorCode(
            () => activateWorldPoint(tables, state, source.row, source.spawner, source.request.objs[0]),
            ErrorCode.SystemLock,
        )
        assert.deepEqual(state, before)
    }
})

test('pure natural activation rejects wrong action, damaged reciprocal FK/duplicates and story clone without any write', () => {
    const source = pointSource(tables)
    const cases = [
        [tables, { ...source.request.objs[0], interact_id: 180 }, ErrorCode.CannotInteract],
        [
            modified('world_filter_mark', 1000001, (row) => {
                row.posId = 10051
            }),
            source.request.objs[0],
            ErrorCode.GameConfig,
        ],
        [
            modified('world_borthpos', 10050, (row) => {
                row.type = 1
            }),
            source.request.objs[0],
            ErrorCode.GameConfig,
        ],
        [
            modified('world_filter_mark', 1000001, (row, list) => list.push({ ...row })),
            source.request.objs[0],
            ErrorCode.GameConfig,
        ],
        [
            modified('common_condition', 12042, (row) => {
                row.name = 'UnsupportedDifferentMeaning'
            }),
            source.request.objs[0],
            ErrorCode.GameConfig,
        ],
        [
            modified('world_borthpos', 10050, (row, list) => list.push({ ...row })),
            source.request.objs[0],
            ErrorCode.GameConfig,
        ],
        [
            modified('world_interact', 31, (row, list) => list.push({ ...row, id: 99131 })),
            source.request.objs[0],
            ErrorCode.GameConfig,
        ],
        [
            modified('world_interact', 31, (row) => {
                row.interactCond = '999999#1'
            }),
            source.request.objs[0],
            ErrorCode.GameConfig,
        ],
    ]
    for (const [current, input, code] of cases) {
        const state = pointCheckpoint(tables)
        const before = structuredClone(state)
        const points = state.world.points
        errorCode(() => activateWorldPoint(current, state, source.row, source.spawner, input), code)
        assert.deepEqual(state, before)
        assert.strictEqual(state.world.points, points)
    }
    const clone = pointSource(tables, 1500001, 6219)
    const state = pointCheckpoint(tables)
    state.world.map_id = 6219
    const before = structuredClone(state)
    errorCode(
        () => activateWorldPoint(tables, state, clone.row, clone.spawner, clone.request.objs[0]),
        ErrorCode.FunctionClosed,
    )
    assert.deepEqual(state, before)
})

test('pure non-transfer objects remain on their existing claim path', () => {
    const object = tables.find('worldmap_100', 1001411)
    const spawner = tables.find('world_spawner', object.spawnerId)
    const state = pointCheckpoint(tables)
    const before = structuredClone(state)
    assert.equal(resolveWorldPointActivation(tables, state, object, spawner, {}), null)
    assert.equal(activateWorldPoint(tables, state, object, spawner, {}), null)
    assert.deepEqual(state, before)
})

test('actual Game leaf checkpoint main+secondary activation emits one9105 before9133, updates153 naturally and survives replay/relogin', () => {
    const f = naturalPointFixture('success')
    try {
        const assets = (s) => ({
            bag: s.player.sbag_infos,
            heroes: s.player.heros_info.heros,
            pets: s.pets,
            souls: s.player.soulessence_infos,
            ornaments: s.ornaments,
        })
        const before = f.state()
        assert.equal(
            before.tasks.find((task) => task.task_id === 106010).nodes.find((node) => node.node_id === 153)
                .node_values[0],
            0,
        )
        const main = pointSource(f.tables)
        const packets = f.call('WorldObjInteract', main.request)
        assert.equal(packets.filter((packet) => packet.id === 9105).length, 1)
        assert.ok(packets.findIndex((packet) => packet.id === 9105) < packets.findIndex((packet) => packet.id === 9133))
        assert.ok(f.decode(packets, 9105).u32s.includes(10050))
        assert.equal(f.decode(packets, 9133).objs[0].obj.complete, true)
        assert.deepEqual(f.decode(packets, 9133).objs[0].rewards.rewards, [])
        const after = f.state()
        assert.deepEqual(assets(after), assets(before))
        assert.equal(after.world.unlockAllMaps, before.world.unlockAllMaps)
        assert.equal(
            after.tasks.find((task) => task.task_id === 106010).nodes.find((node) => node.node_id === 153)
                .node_values[0],
            1,
        )
        assert.ok(
            !after.tasks.find((task) => task.task_id === 106010).finish_nodes.includes(153),
            'point grant does not directly finish task node',
        )
        const revision = after.worldPointRewardRevision
        assert.equal(f.call('WorldObjInteract', main.request).filter((packet) => packet.id === 9105).length, 0)
        assert.equal(f.state().worldPointRewardRevision, revision)
        const secondary = pointSource(f.tables, 201037)
        f.move(secondary)
        const second = f.call('WorldObjInteract', secondary.request)
        assert.equal(second.filter((packet) => packet.id === 9105).length, 1)
        assert.ok(f.state().world.points.includes(1001453))
        assert.equal(f.state().worldPointRewardRevision, revision + 1)
        const session = {}
        f.login(session)
        assert.ok(f.state().world.points.includes(10050) && f.state().world.points.includes(1001453))
    } finally {
        f.store.close()
    }
})

test('actual Game preserves original range checks, rejects premature system and leaves old complete-without-point policy unchanged', () => {
    const f = naturalPointFixture('reject')
    try {
        const source = pointSource(f.tables)
        f.edit((state) => {
            state.tasks.find((task) => task.task_id === 106010).finish_nodes = []
        })
        const before = f.state()
        errorCode(() => f.call('WorldObjInteract', source.request), ErrorCode.SystemLock)
        assert.deepEqual(f.state(), before)
        f.edit((state) => {
            state.tasks.find((task) => task.task_id === 106010).finish_nodes = [185]
            state.world.pos = { x: 1000000, y: 0, z: 0 }
        })
        const far = f.state()
        errorCode(() => f.call('WorldObjInteract', source.request), ErrorCode.InvalidArgument)
        assert.deepEqual(f.state(), far)
        f.move(source)
        f.edit((state) => {
            state.worldObjects['100:200128'] = {
                obj_id: 200128,
                complete: true,
                claims: { complete: true },
                state_data: {},
            }
        })
        const revision = f.state().worldPointRewardRevision
        const packets = f.call('WorldObjInteract', source.request)
        assert.equal(packets.filter((packet) => packet.id === 9105).length, 0)
        assert.ok(!f.state().world.points.includes(10050))
        assert.equal(f.state().worldPointRewardRevision, revision)
    } finally {
        f.store.close()
    }
})

test('actual9133 reply encoding failure rolls back point/object/revision/task plus raw SQL and pending state', () => {
    const f = naturalPointFixture('codec')
    try {
        const source = pointSource(f.tables)
        const request = f.frame('WorldObjInteract', source.request)
        const state = f.state()
        const sql = () => ({
            players: f.store.db
                .prepare('SELECT account_id,state,revision,updated_at FROM players ORDER BY account_id')
                .all(),
            log: f.store.db.prepare('SELECT * FROM request_log ORDER BY id').all(),
            sequences: f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
        })
        const beforeSql = sql()
        const pending = structuredClone([...f.store.pending])
        const pendingReference = f.store.pending.get(f.session.id)
        const original = f.game.handlers.get(9133)
        let observed
        f.game.handlers.set(9133, (c, r) => {
            const result = original(c, r)
            observed = {
                point: c.state.world.points.includes(10050),
                complete: c.state.worldObjects['100:200128'].complete,
                revision: c.state.worldPointRewardRevision,
            }
            return result
        })
        const encode = f.protocol.encode.bind(f.protocol)
        let faults = 0
        f.protocol.encode = (name, value) => {
            if (name === 'cs.SCWorldMapObjInteract') {
                faults++
                assert.equal(value.objs[0].obj.complete, true)
                throw Error('natural point response codec')
            }
            return encode(name, value)
        }
        assert.throws(() => f.game.dispatch(f.session, request), /natural point response codec/)
        assert.equal(faults, 1)
        assert.equal(observed.point, true)
        assert.equal(observed.complete, true)
        assert.ok(observed.revision > 0)
        assert.deepEqual(f.state(), state)
        assert.deepEqual(sql(), beforeSql)
        assert.deepEqual([...f.store.pending], pending)
        assert.strictEqual(f.store.pending.get(f.session.id), pendingReference)
        f.protocol.encode = encode
        f.game.handlers.set(9133, original)
        const packets = f.game.dispatch(f.session, request)
        assert.equal(packets.filter((packet) => packet.id === 9105).length, 1)
        assert.ok(f.state().world.points.includes(10050))
    } finally {
        f.store.close()
    }
})
