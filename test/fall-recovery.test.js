import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { taskBirthPoint } from '../src/task-scenes.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base),
    ground = { x: 12345, y: 10500, z: -23456 },
    air = { x: 12400, y: -10000, z: -23500 }
function fixture(name) {
    let now = 1792814400000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => Math.floor(now / 1000) })
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn),
        move = (pos, is_ground, { stamp, uuid, angle = 45 } = {}) => {
            now += 100
            const s = state(),
                manager = s.player.group_mgrs.find((entry) => entry.type === 1),
                control = manager.groups.find((entry) => entry.id === manager.cur_group).control
            return call('StateUpdate', {
                move_msg: {
                    map_id: s.world.map_id,
                    move: [
                        {
                            uuid: uuid ?? control,
                            info: {
                                pos,
                                angle,
                                is_ground,
                                timestamp: stamp ?? String(now),
                                area_id: s.world.area_id ?? 0,
                            },
                        },
                    ],
                },
            })
        }
    return { store, game, call, login, state, edit, move, session: () => session, time: () => String(now) }
}
const worldPacket = (packets) => {
    const entry = protocol.byName.get('CSProtoWorldMapSync'),
        packet = packets.find((row) => row.id === entry.id)
    assert(packet, 'fall recovery must publish a real transfer, not only an ACK')
    return protocol.decode(entry.rsp, packet.payload)
}
const fall = (f) => f.call('WorldMapActiveBehavior', { type: 1 })

test('actual9102 fall returns to the last accepted grounded pose without healing, changing party, clearing deaths or leaving the scene', () => {
    const f = fixture('fall-grounded')
    try {
        f.move(ground, 1)
        f.move(air, 0)
        f.edit((s) => {
            s.player.heros_info.battle_infos[0].hp = 1
            s.player.heros_info.battle_infos[0].sp = 7
            // A pre-existing synthetic death verifies preservation, not a kill producer.
            s.combat ??= { map_id: s.world.map_id, skills: {}, bullets: {}, elements: {}, entities: {} }
            s.combat.entities.dead = { hp: 0, alive_state: 1 }
        })
        const before = structuredClone(f.state()),
            output = fall(f),
            after = f.state(),
            packet = worldPacket(output)
        assert.equal(packet.cmd, 19)
        assert.equal(packet.map_id, before.world.map_id)
        assert.deepEqual(packet.map_info.players[0].move[0].pos, ground)
        assert.deepEqual(after.world.pos, ground)
        assert.equal(after.world.angle, 45)
        assert.equal(after.world.fall_recovery.pending.source, 'current-ground')
        assert.deepEqual(after.player.heros_info.battle_infos, before.player.heros_info.battle_infos)
        assert.deepEqual(after.player.group_mgrs, before.player.group_mgrs)
        assert.deepEqual(after.combat.entities, before.combat.entities)
        assert.deepEqual(after.worldHistory, before.worldHistory)
        assert.equal(output.filter((p) => p.id === 9102).length, 1)
    } finally {
        f.store.close()
    }
})

test('fall clears riding but preserves the current controlled hero and uses the accepted mount ground report', () => {
    const f = fixture('fall-mount')
    try {
        const s = f.state(),
            mount = s.pets[0].guid,
            manager = s.player.group_mgrs.find((entry) => entry.type === 1),
            control = manager.groups.find((entry) => entry.id === manager.cur_group).control
        f.edit((state) => Object.assign(state.world, { mount, mount_status: 1, status: 1 }))
        f.move(ground, 1, { uuid: mount })
        f.move(air, 0, { uuid: mount })
        const packet = worldPacket(fall(f))
        assert.equal(f.state().world.mount, '0')
        assert.equal(f.state().world.status, 0)
        assert.equal(packet.map_info.players[0].mount, '0')
        assert.equal(packet.map_info.players[0].group.control, control)
        assert.deepEqual(f.state().world.pos, ground)
    } finally {
        f.store.close()
    }
})

test('fall retries keep one destination and old pre-recovery movement cannot snap back or replace the safe record', () => {
    const f = fixture('fall-retry-order')
    try {
        f.move(ground, 1)
        const old = f.time()
        f.move(air, 0)
        fall(f)
        const runtime = structuredClone(f.state().world.fall_recovery)
        fall(f)
        assert.deepEqual(f.state().world.fall_recovery, runtime)
        assert.deepEqual(f.move(air, 1, { stamp: old }), [])
        assert.deepEqual(f.state().world.pos, ground)
        const next = { x: ground.x + 1000, y: ground.y, z: ground.z }
        f.move(next, 1)
        assert.equal(f.state().world.fall_recovery.pending, undefined)
        f.move(air, 0)
        fall(f)
        assert.deepEqual(f.state().world.pos, next)
    } finally {
        f.store.close()
    }
})

test('a deliberate world-point transfer invalidates the prior safe record instead of bringing the player back to an old scene position', () => {
    const f = fixture('fall-transfer-scope')
    try {
        f.move(ground, 1)
        const generation = f.state().world.fall_recovery.generation
        f.call('WorldPoint', { point_id: 10045 })
        assert(f.state().world.fall_recovery.generation > generation)
        assert.equal(f.state().world.fall_recovery.ground, undefined)
        fall(f)
        assert.deepEqual(f.state().world.pos, tables.position(taskBirthPoint(tables, 10045, 100)).pos)
        assert.equal(f.state().world.fall_recovery.pending.source, 'entry-birth')
    } finally {
        f.store.close()
    }
})

test('new login does not reuse a previous connection ground snapshot', () => {
    const f = fixture('fall-login-scope')
    try {
        f.move(ground, 1)
        f.move(air, 0)
        const key = f.state().world.fall_recovery.session
        f.login()
        fall(f)
        assert.notEqual(f.state().world.fall_recovery.session, key)
        assert.notDeepEqual(f.state().world.pos, ground)
        assert.equal(f.state().world.fall_recovery.pending.source, 'entry-birth')
    } finally {
        f.store.close()
    }
})

test('without current ground, real opened checkpoints take precedence and a closed checkpoint cannot be used', () => {
    const f = fixture('fall-open-checkpoint')
    try {
        f.call('WorldPoint', { point_id: 10045 })
        const a = taskBirthPoint(tables, 100401, 100),
            b = taskBirthPoint(tables, 100402, 100),
            ap = tables.position(a),
            bp = tables.position(b)
        f.call('WorldCheckpointOpen', { checkpoint_id: a.id })
        f.call('WorldCheckpointOpen', { checkpoint_id: b.id })
        f.edit((s) => {
            s.world.pos = { x: bp.pos.x, y: -10000, z: bp.pos.z }
        })
        fall(f)
        assert.deepEqual(f.state().world.pos, bp.pos)
        assert.equal(f.state().world.fall_recovery.pending.source, 'active-checkpoint')
        f.call('WorldPoint', { point_id: 10045 })
        f.call('WorldCheckpointClose', { checkpoint_id: b.id })
        fall(f)
        assert.deepEqual(f.state().world.pos, ap.pos)
    } finally {
        f.store.close()
    }
})

test('fall removes only the local player battle relations and never sends a global hatred reset or respawns opponents', () => {
    const f = fixture('fall-local-relations')
    try {
        f.move(ground, 1)
        f.move(air, 0)
        const local = f.session().id,
            a = ((3n << 56n) | 12345n).toString(),
            b = ((3n << 56n) | 12346n).toString()
        f.call('ObjHatredIncSync', { inc: true, info: { id: a, target_obj_ids: [], player_obj_ids: [local] } })
        f.call('PlayerHatredIncSync', {
            inc: true,
            info: { id: String(local), target_obj_ids: [a], player_obj_ids: [] },
        })
        f.call('ObjHatredIncSync', { inc: true, info: { id: b, target_obj_ids: [], player_obj_ids: [local + 1] } })
        const output = fall(f),
            hatred = f.state().combat.hatred
        assert.equal(hatred.players[String(local)], undefined)
        assert.equal(hatred.objects[a], undefined)
        assert.deepEqual(hatred.objects[b].player_obj_ids, [local + 1])
        assert(!output.some((p) => p.id === 10808))
    } finally {
        f.store.close()
    }
})

test('movement and recovery packet faults roll back snapshots, destinations and relation changes before retry', () => {
    const f = fixture('fall-packet-rollback')
    try {
        f.move(ground, 1)
        const original = f.game.packet,
            beforeMove = structuredClone(f.state())
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoStateUpdateBC') throw Error('ground packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.move(air, 1), /ground packet fault/)
        assert.deepEqual(f.state(), beforeMove)
        f.game.packet = original
        f.move(air, 0)
        const before = structuredClone(f.state())
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoWorldMapSync') throw Error('fall packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => fall(f), /fall packet fault/)
        assert.deepEqual(f.state(), before)
        f.game.packet = original
        fall(f)
        assert.deepEqual(f.state().world.pos, ground)
    } finally {
        f.store.close()
    }
})

test('type3 keeps its non-teleport healing contract and reserved/invalid types never get fabricated recovery', () => {
    const f = fixture('fall-type-separation')
    try {
        f.move(ground, 1)
        f.move(air, 0)
        const before = structuredClone(f.state().world)
        const output = f.call('WorldMapActiveBehavior', { type: 3 })
        assert.deepEqual(f.state().world, before)
        assert(!output.some((p) => p.id === 9103))
        for (const type of [2, 99])
            assert.throws(
                () => f.call('WorldMapActiveBehavior', { type }),
                (error) => error.code === ErrorCode.InvalidProtoID,
            )
    } finally {
        f.store.close()
    }
})

test('a scene without any real return point fails atomically instead of inventing a global fallback destination', () => {
    const f = fixture('fall-no-birth')
    try {
        f.edit((s) => {
            s.world.map_id = 999999
            s.world.point_id = 0
            s.world.pos = { ...air }
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => fall(f),
            (error) => error.code === ErrorCode.NotFoundBirthPoint,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('uint64 movement boundaries retain precision and reject a pre-recovery timestamp above safe integer range', () => {
    const f = fixture('fall-uint64')
    try {
        f.move(ground, 1, { stamp: '9007199254740993' })
        f.move(air, 0, { stamp: '9007199254740994' })
        fall(f)
        assert.equal(f.state().world.fall_recovery.minimum_timestamp, '9007199254740994')
        assert.deepEqual(f.move(air, 1, { stamp: '9007199254740993' }), [])
        assert.deepEqual(f.state().world.pos, ground)
        f.move(ground, 1, { stamp: '9007199254740995' })
        assert.equal(f.state().world.fall_recovery.pending, undefined)
    } finally {
        f.store.close()
    }
})

test('malformed persisted recovery is rejected with a named configuration error and no partial transfer', () => {
    const f = fixture('fall-broken-runtime')
    try {
        f.move(ground, 1)
        const valid = structuredClone(f.state().world.fall_recovery)
        for (const change of [
            { pending: 1 },
            { pending: { source: 'invented', target: {} } },
            { latest_timestamp: undefined },
        ]) {
            f.edit((s) => {
                s.world.fall_recovery = { ...valid, ...change }
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => fall(f),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
