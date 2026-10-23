import { populateParty } from './party-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { afterBattlePassBeforePush } from './battle-pass-packet-fixture.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
function fixture() {
    let now = 1800000000
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    let seq = 1
    const decode = (p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }),
        call = (name, r = {}) => {
            const e = protocol.byName.get('CSProto' + name)
            return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) }).map(decode)
        }
    call('EnterGame', { open_id: 'move-player' })
    store.transact(session.id, 0, populateParty)
    return {
        store,
        session,
        call,
        state: () => store.load(session.id).state,
        setNow: (value) => {
            now = value
        },
        tick: () => game.tick(session.id).map(decode),
    }
}
test('CBT3 omitted zero coordinate fields and heading persist into world re-entry with millisecond timestamp', () => {
    const f = fixture()
    try {
        const before = f.state(),
            control = before.player.group_mgrs[0].groups[0].control
        const move = (info) =>
            f.call('StateUpdate', { move_msg: { map_id: before.world.map_id, move: [{ uuid: control, info }] } })
        assert.equal(move({ pos: { x: 123, y: 456, z: 789 }, angle: 90, timestamp: '1800000000000' })[0].id, 11074)
        move({ pos: { y: 50 }, timestamp: '1800000000100' })
        assert.deepEqual(f.state().world.pos, { x: 0, y: 50, z: 0 })
        assert.equal(f.state().world.angle, 0)
        const packets = f.call('EnterWorldMap', { map_id: before.world.map_id })
        const sync = packets.find((p) => p.id === protocol.byName.get('CSProtoWorldMapSync').id).data.map_info
            .players[0].move[0]
        assert.deepEqual(sync.pos, { x: 0, y: 50, z: 0 })
        assert.equal(sync.timestamp, '1800000000000')
        move({ pos: {} })
        assert.deepEqual(f.state().world.pos, { x: 0, y: 0, z: 0 })
    } finally {
        f.store.close()
    }
})
test('movement from other actors cannot move player and malformed batches roll back', () => {
    const f = fixture()
    try {
        const s = f.state(),
            control = s.player.group_mgrs[0].groups[0].control
        const req = (move) => ({ move_msg: { map_id: s.world.map_id, move } })
        f.call('StateUpdate', req([{ uuid: '216172790703918911', info: { pos: { x: 100 } } }]))
        assert.deepEqual(f.state().world.pos, s.world.pos)
        const before = f.store.load(f.session.id)
        assert.throws(() =>
            f.call(
                'StateUpdate',
                req([
                    { uuid: control, info: { pos: { x: 10 } } },
                    { uuid: control, info: { pos: { x: 100000000 } } },
                ]),
            ),
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('optimistic CBT3 hero switch synchronizes the selected formation and preserves movement through repeated switches', () => {
    const f = fixture()
    try {
        const s = f.state(),
            [a, b] = s.player.group_mgrs[0].groups[0].heros.map((h) => h.hero_id)
        const move = (uuid, x) =>
            f.call('StateUpdate', {
                move_msg: {
                    map_id: s.world.map_id,
                    move: [{ uuid, info: { pos: { x, y: 250, z: -321 }, angle: 70 } }],
                },
            })
        move(a, 100)
        for (const [old, next, x] of [
            [a, b, 200],
            [b, a, 300],
        ]) {
            const packets = f.call('SwitchWorldGroupControl', {
                type: 1,
                control: next,
                pos: { x: 0, y: 0, z: 0 },
                angle: 0,
                switch_type: 56,
            })
            assert.equal(packets[0].id, protocol.byName.get('CSProtoSyncPlayerData').id)
            const manager = f.state().player.group_mgrs.find((m) => m.type === 1)
            assert.equal(manager.groups.find((g) => g.id === manager.cur_group).control, next)
            const syncType = protocol.byName.get('CSProtoSyncPlayerData').rsp
            assert.deepEqual(
                packets[0].data,
                protocol.decode(
                    syncType,
                    protocol.encode(syncType, {
                        group_mgrs: [
                            {
                                type: manager.type,
                                src: 1,
                                cur_group: manager.cur_group,
                                groups: manager.groups.filter((group) => group.id === manager.cur_group),
                            },
                        ],
                    }),
                ),
            )
            const rest = afterBattlePassBeforePush(packets.slice(1), tables, f.state(), 1800000000)
            assert.deepEqual(
                rest.map((p) => p.id),
                [protocol.byName.get('CSProtoSwitchWorldGroupControl').id],
            )
            assert.deepEqual(rest[0].data, {})
            assert.notEqual(f.state().world.pos.x, 0)
            move(old, 999)
            move(next, x)
            f.call('SwitchGroupControlEnd', { uuid: next })
            assert.equal(f.state().world.pos.x, x)
            const sync = f
                .call('EnterWorldMap', { map_id: s.world.map_id })
                .find((p) => p.id === protocol.byName.get('CSProtoWorldMapSync').id)
            assert.equal(sync.data.map_info.players[0].move[0].pos.x, x)
            assert.equal(sync.data.map_info.players[0].group.control, next)
        }
    } finally {
        f.store.close()
    }
})

test('movement confirmation refreshes the CBT3 25m birth-position fallback before switching', () => {
    const f = fixture()
    try {
        const state = f.state(),
            [a, b] = state.player.group_mgrs[0].groups[0].heros.map((h) => h.hero_id)
        let mapPosition = state.world.pos
        const moved = { x: mapPosition.x + 10000, y: mapPosition.y, z: mapPosition.z }
        const birth = (current) => {
            const distance = ['x', 'y', 'z'].reduce((n, k) => n + ((current[k] - mapPosition[k]) / 100) ** 2, 0)
            return distance >= 625 ? mapPosition : current
        }
        assert.notDeepEqual(birth(moved), moved)
        const packets = f.call('StateUpdate', {
            move_msg: {
                map_id: state.world.map_id,
                move: [{ uuid: a, info: { pos: moved, timestamp: '1800000000200' } }],
            },
        })
        const confirmation = packets.find((p) => p.id === 11074)
        assert(confirmation)
        mapPosition = confirmation.data.move_msg.move[0].info.pos
        f.call('SwitchWorldGroupControl', { type: 1, control: b, pos: {}, switch_type: 56 })
        assert.deepEqual(birth(moved), moved)
        assert.deepEqual(
            f.call('StateUpdate', {
                move_msg: { map_id: state.world.map_id, move: [{ uuid: a, info: { pos: { x: 1, y: 1, z: 1 } } }] },
            }),
            [],
        )
    } finally {
        f.store.close()
    }
})

test('mount movement becomes the player position and dismount keeps the latest mounted coordinate', () => {
    const f = fixture()
    try {
        const state = f.state(),
            hero = state.player.group_mgrs[0].groups[0].control,
            mount = state.pets.find((p) => tables.find('mount', p.config_id)).guid
        f.call('WorldMapPlayerStatus', { status: 1, arg: mount, doRecord: true })
        const newPos = { x: 17234, y: 18900, z: -36210 },
            move = f.call('StateUpdate', {
                move_msg: {
                    map_id: state.world.map_id,
                    move: [
                        { uuid: hero, info: { pos: { x: 1, y: 2, z: 3 } } },
                        { uuid: mount, info: { pos: newPos, angle: 37, timestamp: '1800000001200' } },
                    ],
                },
            })
        assert.deepEqual(f.state().world.pos, newPos)
        assert.equal(move.find((x) => x.id === 11074).data.move_msg.move[0].uuid, mount)
        const dismount = f.call('WorldMapPlayerStatus', { status: 0, arg: '0', doRecord: true })
        assert.deepEqual(
            dismount.filter((x) => x.id === 9103).map((x) => x.data.cmd),
            [17, 25],
        )
        assert(dismount.filter((x) => x.id === 9103).every((x) => x.data.map_info.players[0].move.length === 0))
        assert.deepEqual(f.state().world.pos, newPos)
        const enter = f.call('EnterWorldMap', { map_id: state.world.map_id }).find((x) => x.id === 9103)
        assert.deepEqual(enter.data.map_info.players[0].move[0].pos, newPos)
    } finally {
        f.store.close()
    }
})

test('scene entry ignores only in-flight movement from its previous map until destination confirmation', () => {
    const f = fixture()
    try {
        const origin = f.state().world.map_id
        const control = f.state().player.group_mgrs[0].groups[0].control
        const move = (map, uuid = control) =>
            f.call('StateUpdate', {
                move_msg: {
                    map_id: map,
                    move: [{ uuid, info: { pos: { x: 58027, y: 10115, z: -10669 }, timestamp: '1800000000000' } }],
                },
            })
        f.call('EnterWorldMap', { map_id: 6231, point_id: 623101 })
        const entered = f.state(),
            revision = f.store.load(f.session.id).revision
        const logs = f.store.db.prepare('SELECT COUNT(*) AS count FROM request_log').get().count
        assert.deepEqual(move(origin), [], 'the source-map movement race must not produce a protocol error')
        assert.deepEqual(f.state(), entered, 'source movement must not overwrite the dungeon birth position')
        assert.equal(f.store.load(f.session.id).revision, revision, 'ignored movement must not write player data')
        assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM request_log').get().count, logs)
        assert.throws(() => move(9999), /Wrong map/, 'an unrelated map remains invalid')
        move(6231, '216172790703918911')
        assert.deepEqual(move(origin), [], 'an uncontrolled actor cannot confirm arrival')
        assert.ok(move(6231).some((packet) => packet.id === 11074))
        assert.throws(() => move(origin), /Wrong map/, 'destination movement ends the transition allowance')
    } finally {
        f.store.close()
    }
})

test('scene loaded and point acknowledgments end the allowance for old-map movement', () => {
    const f = fixture()
    try {
        const origin = f.state().world.map_id
        const control = f.state().player.group_mgrs[0].groups[0].control
        const oldMove = (map) =>
            f.call('StateUpdate', { move_msg: { map_id: map, move: [{ uuid: control, info: { pos: { x: 1 } } }] } })
        f.call('EnterWorldMap', { map_id: 6231, point_id: 623101 })
        f.call('WorldPointAck')
        assert.deepEqual(oldMove(origin), [], 'a point ack cannot acknowledge a different scene-load flow')
        f.call('MultiCampaignPlayerLoaded')
        assert.throws(() => oldMove(origin), /Wrong map/)
        f.call('WorldPoint', { point_id: 10045 })
        assert.deepEqual(oldMove(6231), [])
        f.call('WorldPointAck')
        assert.throws(() => oldMove(6231), /Wrong map/)
    } finally {
        f.store.close()
    }
})
