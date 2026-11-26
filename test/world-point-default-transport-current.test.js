import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { newStarterProfile } from '../src/starter-profile.js'
import { SystemUnlocks } from '../src/system-unlocks.js'
import { TaskGraphs, acceptTask, makeNode } from '../src/tasks.js'
import { currentDefaultTransferPoint } from '../src/world-point-access.js'
import { ErrorCode } from '../src/error-codes.js'
import { pointSource } from './world-point-activation-current-fixture.js'

const cfg = configuration(),
    base = new Tables(cfg.tables),
    now = 1800000000
function fixture(name, tables = base) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    store.login(name, (id, account) => {
        const state = seedPlayer(tables, id, account)
        state.starterProfile = newStarterProfile('normal')
        state.world.points = []
        delete state.world.unlockAllMaps
        return state
    })
    let seq = 1
    const frame = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0) }
    }
    const dispatch = (frame) => game.dispatch(session, frame),
        call = (name, r) => dispatch(frame(name, r)),
        state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn),
        raw = () => ({
            player: store.load(session.id),
            rows: store.db.prepare('SELECT state,revision,updated_at FROM players').all(),
            logs: store.db.prepare('SELECT * FROM request_log ORDER BY id').all(),
            sequences: store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
            pending: [...store.pending],
        })
    call('EnterGame', { open_id: name })
    assert.equal(state().starterProfile.mode, 'normal')
    assert.deepEqual(state().world.points, [])
    // Explicit normal progression LEAF checkpoint, not complete startup replay.
    edit((s) => {
        const source = pointSource(tables),
            g = new TaskGraphs(tables).get(106010)
        Object.assign(s.world, { map_id: 100, pos: source.pos })
        s.tasks = []
        const task = acceptTask(g, s, now)
        task.nodes = [makeNode(g, 153, s)]
        task.finish_nodes = [185]
    })
    call('WorldTimeSync', { world_time: 43200 })
    assert(new SystemUnlocks(tables).inspect(state()).unlocked.includes(151))
    const enter = (id) => {
        const p = tables.find('world_borthpos', id)
        return call('EnterWorldMap', { map_id: p.cityId, point_id: id })
    }
    return {
        tables,
        protocol,
        store,
        game,
        session,
        state,
        edit,
        raw,
        frame,
        dispatch,
        call,
        enter,
        close: () => store.close(),
    }
}
function unchanged(f, fn, predicate) {
    const before = f.raw()
    assert.throws(fn, predicate)
    assert.deepEqual(f.raw(), before)
}
const assets = (s) =>
    structuredClone({
        bag: s.player.sbag_infos,
        heros: s.player.heros_info.heros,
        pets: s.pets,
        eggs: s.petEggs,
        souls: s.player.soulessence_infos,
        ornaments: s.ornaments,
    })
const modified = (name, id, change) => {
    const values = structuredClone(base.get(name))
    change(
        values.find((r) => r.id === id),
        values,
    )
    const tables = Object.create(base)
    tables.get = (key) => (key === name ? values : base.get(key))
    tables.find = (key, target) => (key === name ? values.find((r) => r.id === Number(target)) : base.find(key, target))
    return tables
}

test('neutral default admission uses current city/type2/lock0 and reciprocal transfer source, not all birth defaults or GM flags', () => {
    const eligible = []
    for (const marker of base.get('world_filter_mark').filter((m) => [2, 44].includes(m.markType))) {
        const point = base.find('world_borthpos', marker.posId)
        if (point?.cityId !== marker.worldId || point.type !== 2 || point.lockPoint !== 0) continue
        const result = currentDefaultTransferPoint(
            base,
            { world: { map_id: point.cityId, points: [], unlockAllMaps: true } },
            point,
        )
        if (result) eligible.push(result.pointId)
    }
    assert.deepEqual(
        [...new Set(eligible)].sort((a, b) => a - b),
        [20005, 101027],
    )
    assert.equal(
        currentDefaultTransferPoint(
            base,
            { world: { map_id: 100, points: [], unlockAllMaps: true } },
            base.find('world_borthpos', 10001),
        ),
        null,
    )
    const p = base.find('world_borthpos', 10050)
    assert.equal(p.lockPoint, 1)
    assert.equal(currentDefaultTransferPoint(base, { world: { map_id: 100 } }, p), null)
})

test('actual current same-scene9132 returns both normal defaults with empty stored points without granting point entitlement or rewards', () => {
    const f = fixture('default-world-point-positive')
    try {
        for (const id of [20005, 101027]) {
            f.enter(id)
            const point = base.find('world_borthpos', id),
                destination = base.position(point),
                before = assets(f.state()),
                revision = f.state().worldPointRewardRevision
            f.edit((s) => {
                s.world.pos = { ...s.world.pos, x: s.world.pos.x + 1000 }
            })
            const frames = f.call('WorldPoint', { point_id: id, trans_type: 0, is_stuck: false })
            assert(frames.some((p) => p.id === 9132))
            assert(frames.some((p) => p.id === 9103))
            for (const pointSync of frames.filter((p) => p.id === 9105))
                assert.deepEqual(f.protocol.decode(f.protocol.byId.get(9105).rsp, pointSync.payload).u32s ?? [], [])
            assert.equal(f.state().world.map_id, point.cityId)
            assert.equal(f.state().world.point_id, id)
            assert.deepEqual(f.state().world.pos, destination.pos)
            assert.deepEqual(f.state().world.points, [])
            assert.equal(f.state().worldPointRewardRevision, revision)
            assert.notEqual(f.state().world.unlockAllMaps, true)
            assert.deepEqual(assets(f.state()), before)
        }
    } finally {
        f.close()
    }
})

test('existing owned point qualification keeps locked and cross-map saved-asset paths unchanged', () => {
    const f = fixture('default-world-point-owned')
    try {
        f.call('WorldObjInteract', pointSource(base).request)
        assert(f.state().world.points.includes(10050))
        assert(f.call('WorldPoint', { point_id: 10050 }).some((p) => p.id === 9132))
        // Explicit already-owned legacy membership; not a new grant producer.
        f.edit((s) => {
            s.world.points.push(20005)
        })
        assert(f.call('WorldPoint', { point_id: 20005 }).some((p) => p.id === 9132))
        assert.equal(f.state().world.map_id, 200)
        assert(f.state().world.points.includes(10050) && f.state().world.points.includes(20005))
    } finally {
        f.close()
    }
})

test('current unowned lock1, story birth/clone, other-city default and GM-flag-only attempts are rejected atomically', () => {
    const f = fixture('default-world-point-denied')
    try {
        unchanged(
            f,
            () => f.call('WorldPoint', { point_id: 10050 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        unchanged(
            f,
            () => f.call('WorldPoint', { point_id: 20005 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        f.edit((s) => {
            s.world.unlockAllMaps = true
        })
        unchanged(
            f,
            () => f.call('WorldPoint', { point_id: 101027 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        const story = base.find('world_borthpos', 10201)
        assert.notEqual(story.type, 2)
        f.edit((s) => Object.assign(s.world, base.position(story)))
        unchanged(
            f,
            () => f.call('WorldPoint', { point_id: story.id }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        const object = base.find('worldmap_6219', 1500001),
            clone = base.find('world_borthpos', 621901)
        assert(clone)
        f.edit((s) => Object.assign(s.world, base.position(clone)))
        unchanged(
            f,
            () => f.call('WorldPoint', { point_id: clone.id }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        unchanged(
            f,
            () => f.call('WorldPoint', { point_id: object.expandId }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
    } finally {
        f.close()
    }
})

test('duplicate markers and cross-scene cloned FK cannot authorize an implicit default', () => {
    const marker = base.get('world_filter_mark').find((m) => m.worldId === 200 && m.posId === 20005)
    const cases = [
        [modified('world_filter_mark', marker.id, (row, rows) => rows.push({ ...row })), ErrorCode.GameConfig],
        // The same low object ID1500001 is a type3 NPC on map200 and a
        // type21 story clone on6219. Neither can substitute for200006.
        [
            modified('world_filter_mark', marker.id, (row) => {
                row.worldmapId = 1500001
            }),
            ErrorCode.InvalidArgument,
        ],
        [
            modified('worldmap_200', marker.worldmapId, (row) => {
                row.cityId = 6219
            }),
            ErrorCode.GameConfig,
        ],
    ]
    for (const [index, [tables, code]] of cases.entries()) {
        const f = fixture('default-world-point-source-' + index, tables)
        try {
            f.enter(20005)
            unchanged(
                f,
                () => f.call('WorldPoint', { point_id: 20005 }),
                (e) => e.code === code,
            )
        } finally {
            f.close()
        }
    }
})

test('actual9132 ACK codec and SQL failure roll back position/transport tuple, then the same real frame retries', () => {
    const f = fixture('default-world-point-atomic')
    try {
        f.enter(20005)
        const target = base.position(base.find('world_borthpos', 20005)).pos
        f.edit((s) => {
            s.world.pos = { ...s.world.pos, x: s.world.pos.x + 1000 }
        })
        const frame = f.frame('WorldPoint', { point_id: 20005, trans_type: 0, is_stuck: false }),
            packet = f.game.packet
        let observedDestination = false
        f.game.packet = function (name, value, options) {
            if (
                name === 'CSProtoWorldMapSync' &&
                value.map_info?.players?.some((p) => p.move?.some((m) => m.pos?.x === target.x))
            )
                observedDestination = true
            if (name === 9132) {
                assert(observedDestination)
                throw Error('default-point-codec')
            }
            return packet.call(this, name, value, options)
        }
        unchanged(f, () => f.dispatch(frame), /default-point-codec/)
        assert(observedDestination)
        f.game.packet = packet
        f.store.db.exec(
            "CREATE TRIGGER default_point_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'default-point-sql'); END",
        )
        unchanged(f, () => f.dispatch(frame), /default-point-sql/)
        f.store.db.exec('DROP TRIGGER default_point_fail')
        assert(f.dispatch(frame).some((p) => p.id === 9132))
        assert.deepEqual(f.state().world.pos, target)
        assert.deepEqual(f.state().world.points, [])
    } finally {
        f.close()
    }
})

test('default point admission keeps common System null/stale metadata strict and rolls back the transport', () => {
    for (const variant of ['null', 'stale']) {
        const f = fixture('default-world-point-system-' + variant)
        try {
            f.enter(20005)
            f.edit((s) => {
                s.world.pos = { ...s.world.pos, x: s.world.pos.x + 1000 }
                if (variant === 'null') s.systemUnlockProgress = null
                else s.systemUnlockProgress.sourceHash = 'stale'
            })
            unchanged(
                f,
                () => f.call('WorldPoint', { point_id: 20005 }),
                (e) => e.code === ErrorCode.GameConfig,
            )
        } finally {
            f.close()
        }
    }
})
