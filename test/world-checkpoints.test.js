import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { checkpointSnapshot } from '../src/world-checkpoints.js'
import { worldSync } from '../src/handlers/world.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(database = ':memory:', openId = 'checkpoint-b08') {
    const store = new Store(database),
        protocol = new Protocol(cfg.base),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: openId })
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1, time: 1 }))
    })
    return { store, protocol, game, session, call, state: () => store.load(session.id).state }
}
const open = (id = 100403, type = 0, owner = 0) => ({
    checkpoint_id: id,
    checkpoint_infos: [{ checkpoint_type: type, args: [owner] }],
})
function setMap(f, id) {
    f.store.transact(f.session.id, 0, (s) => {
        s.world.map_id = id
    })
}

test('9134 opens each of the eight current type4 points, returns sorted IDs and sends a full authoritative 9147 after ACK', () => {
    const f = fixture()
    try {
        const points = JSON.parse(
            fs.readFileSync(new URL('../configs/task-tables/world_borthpos.json', import.meta.url)),
        ).filter((p) => p.type === 4)
        assert.equal(points.length, 8)
        for (const point of points) {
            setMap(f, point.cityId)
            const before = structuredClone({
                    bag: f.state().player.common_bag,
                    attrs: f.state().player.attr_infos,
                    heroes: f.state().player.heros_info,
                }),
                world = structuredClone(f.state().world),
                tasks = structuredClone(f.state().tasks)
            const packets = f.call('WorldCheckpointOpen', open(point.id)),
                reply = packets.find((p) => p.id === 9134),
                sync = packets.find((p) => p.id === 9147)
            assert.ok(reply.data.u32s.includes(point.id))
            assert.deepEqual(sync.data.checkpoint_ids, reply.data.u32s)
            assert.ok(packets.indexOf(reply) < packets.indexOf(sync))
            assert.deepEqual(
                {
                    bag: f.state().player.common_bag,
                    attrs: f.state().player.attr_infos,
                    heroes: f.state().player.heros_info,
                },
                before,
            )
            assert.deepEqual(f.state().world, world)
            assert.deepEqual(f.state().tasks, tasks)
            const saved = f.state().worldCheckpoints
            f.call('WorldCheckpointOpen', open(point.id))
            assert.deepEqual(f.state().worldCheckpoints, saved)
        }
    } finally {
        f.store.close()
    }
})

test('9134 validates checkpoint kind/map and owner lifetime before mutation; task/playable references remain distinct', () => {
    const f = fixture()
    try {
        setMap(f, 100)
        const cases = [
            [open(0), ErrorCode.ParamError],
            [open(123456789), ErrorCode.NotFoundBirthPoint],
            [open(10045), ErrorCode.NotFoundBirthPoint],
            [open(620203), ErrorCode.NotSameCity],
            [open(100403, 99), ErrorCode.ParamError],
            [open(100403, 0, 12), ErrorCode.ParamError],
            [open(100403, 1, 62026), ErrorCode.PlayableNotStart],
            [open(100403, 2, 99999999), ErrorCode.PlayerTaskNotFound],
            [{ checkpoint_id: 100403, checkpoint_infos: [{ checkpoint_type: 2, args: [1, 2] }] }, ErrorCode.ParamError],
        ]
        for (const [request, code] of cases) {
            const before = f.state()
            assert.throws(
                () => f.call('WorldCheckpointOpen', request),
                (error) => error.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = [{ task_id: 106001, nodes: [] }]
            s.playableRuns = { 62026: { map_id: 100, status: 1, play_id: 62026 } }
        })
        f.call('WorldCheckpointOpen', open(100403, 2, 106001))
        f.call('WorldCheckpointOpen', open(100403, 1, 62026))
        assert.equal(Object.keys(f.state().worldCheckpoints[100][100403].sources).length, 2)
    } finally {
        f.store.close()
    }
})

test('9134 rolls back the persisted reference if the full 9147 cannot be encoded', () => {
    const f = fixture()
    try {
        setMap(f, 100)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol),
            schema = f.protocol.byId.get(9147).rsp
        f.protocol.encode = (type, value) => {
            if (type === schema) throw Error('checkpoint codec failure')
            return encode(type, value)
        }
        assert.throws(() => f.call('WorldCheckpointOpen', open()), /checkpoint codec failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('WorldCheckpointOpen', open())
        assert.deepEqual(checkpointSnapshot(f.state()).checkpoint_ids, [100403])
    } finally {
        f.store.close()
    }
})

test('checkpoint references survive a real SQLite close/reopen and synchronize on scene entry without teleporting', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-checkpoint-')),
        database = path.join(folder, 'save.sqlite')
    let f = fixture(database, 'checkpoint-sqlite')
    try {
        setMap(f, 100)
        f.call('WorldCheckpointOpen', open())
        f.store.close()
        f = fixture(database, 'checkpoint-sqlite')
        assert.deepEqual(checkpointSnapshot(f.state()).checkpoint_ids, [100403])
        const state = f.state(),
            oldWorld = structuredClone(state.world),
            packets = []
        worldSync({
            state,
            tables,
            id: f.session.id,
            now: 1792690000,
            push: (name, data) => packets.push({ name, data }),
        })
        assert.deepEqual(packets.find((p) => p.name === 'CSProtoWorldCheckpointSync').data.checkpoint_ids, [100403])
        assert.deepEqual(state.world.pos, oldWorld.pos)
        state.world.map_id = 6202
        assert.deepEqual(checkpointSnapshot(state).checkpoint_ids, [])
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()))
        assert.ok(path.basename(folder).startsWith('lurukaps-checkpoint-'))
        fs.rmSync(folder, { recursive: true, force: true })
    }
})

const close = (id = 100403, type = 0, owner = 0) => ({
    checkpoint_id: id,
    checkpoint_info: { checkpoint_type: type, args: [owner] },
})

test('checkpoint final synchronization uses the final scene after a same-request transfer', () => {
    const f = fixture()
    try {
        setMap(f, 100)
        const id = f.protocol.byName.get('CSProtoWorldCheckpointOpen').id,
            original = f.game.handlers.get(id)
        f.game.handlers.set(id, (c, r) => {
            const response = original(c, r)
            c.state.world.map_id = 6202
            return response
        })
        const packets = f.call('WorldCheckpointOpen', open()),
            syncs = packets.filter((p) => p.id === 9147)
        assert.deepEqual(f.state().worldCheckpoints[100][100403].sources['0:0'], { checkpoint_type: 0, args: [] })
        assert.deepEqual(syncs.at(-1).data.checkpoint_ids, [])
        assert.ok(packets.indexOf(syncs.at(-1)) > packets.findIndex((p) => p.id === 9134))
    } finally {
        f.store.close()
    }
})

test('9145 removes only its matching source and the post-ACK full list repairs unconditional client removal', () => {
    const f = fixture()
    try {
        setMap(f, 100)
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = [{ task_id: 106001, nodes: [] }]
        })
        f.call('WorldCheckpointOpen', open())
        f.call('WorldCheckpointOpen', open(100403, 2, 106001))
        // A finished task must still be able to release its previously opened reference.
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = []
        })
        const packets = f.call('WorldCheckpointClose', close(100403, 2, 106001)),
            reply = packets.find((p) => p.id === 9145),
            sync = packets.find((p) => p.id === 9147)
        assert.deepEqual(reply.data.u32s, [100403])
        assert.deepEqual(sync.data.checkpoint_ids, [100403])
        assert.ok(packets.indexOf(reply) < packets.indexOf(sync))
        assert.deepEqual(Object.keys(f.state().worldCheckpoints[100][100403].sources), ['0:0'])
        f.call('WorldCheckpointClose', close(100403, 2, 106001))
        assert.deepEqual(checkpointSnapshot(f.state()).checkpoint_ids, [100403])
        const last = f.call('WorldCheckpointClose', close())
        assert.deepEqual(last.find((p) => p.id === 9147).data.checkpoint_ids, [])
        const saved = f.state().worldCheckpoints
        f.call('WorldCheckpointClose', close())
        assert.deepEqual(f.state().worldCheckpoints, saved)
    } finally {
        f.store.close()
    }
})

test('9145 rejects malformed and wrong-map closes and rolls back when its post-ACK synchronization cannot encode', () => {
    const f = fixture()
    try {
        setMap(f, 100)
        f.call('WorldCheckpointOpen', open())
        for (const [request, code] of [
            [close(620203), ErrorCode.NotSameCity],
            [close(100403, 99), ErrorCode.ParamError],
            [close(100403, 0, 12), ErrorCode.ParamError],
            [close(100403, 2, 0), ErrorCode.ParamError],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('WorldCheckpointClose', request),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol),
            schema = f.protocol.byId.get(9147).rsp
        f.protocol.encode = (type, value) => {
            if (type === schema) throw Error('checkpoint close codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('WorldCheckpointClose', close()), /checkpoint close codec/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('WorldCheckpointClose', close())
        assert.deepEqual(checkpointSnapshot(f.state()).checkpoint_ids, [])
    } finally {
        f.store.close()
    }
})

test('9145 closed checkpoints stay closed after a real SQLite reopen', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-checkpoint-')),
        database = path.join(folder, 'save.sqlite')
    let f = fixture(database, 'checkpoint-close-sqlite')
    try {
        setMap(f, 100)
        f.call('WorldCheckpointOpen', open())
        f.call('WorldCheckpointClose', close())
        f.store.close()
        f = fixture(database, 'checkpoint-close-sqlite')
        assert.deepEqual(checkpointSnapshot(f.state()).checkpoint_ids, [])
        const packets = f.call('WorldCheckpointClose', close())
        assert.deepEqual(packets.find((p) => p.id === 9147).data.checkpoint_ids, [])
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()))
        assert.ok(path.basename(folder).startsWith('lurukaps-checkpoint-'))
        fs.rmSync(folder, { recursive: true, force: true })
    }
})
