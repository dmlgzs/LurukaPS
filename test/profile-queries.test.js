import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { configTime } from '../src/shops.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
function fixture() {
    let now = configTime(tables.get('abbys_time')[0].startTime) + 1
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const send = (who, name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: 55, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    send(session, 'EnterGame', { open_id: 'profile-test' })
    return {
        store,
        session,
        send,
        call: (n, r) => send(session, n, r),
        state: () => store.load(session.id).state,
        setTime: (t) => {
            now = t
        },
    }
}
test('hero records merge by config/category and survive login without unlocking content', () => {
    const f = fixture()
    try {
        const hero = f.state().player.heros_info.heros.find((h) => tables.find('char_data', h.conf_id)?.characterStory)
        const id = Number(tables.find('char_data', hero.conf_id).characterStory.split('|')[0])
        const result = f.call('CharDataUpdateHero', { hero_id: hero.conf_id, type_id: 1, record_id: [id, id] })[0].data
        assert.deepEqual(result.infos[0].record_id, [id])
        assert.equal(result.hero_id, hero.conf_id)
        const again = {}
        f.send(again, 'EnterGame', { open_id: 'profile-test' })
        assert.deepEqual(f.send(again, 'CharDataGetAll')[0].data.heros_char_data[0].infos[0].record_id, [id])
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('CharDataUpdateHero', { hero_id: hero.conf_id, type_id: 1, record_id: [999] }))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})
test('friend recommendations show actual local profiles without private account or wallet data', () => {
    const f = fixture()
    try {
        assert.deepEqual(f.call('FriendRecommend')[0].data.player_infos, [])
        const other = {}
        f.send(other, 'EnterGame', { open_id: 'do-not-expose-account' })
        const players = f.call('FriendRecommend')[0].data.player_infos
        assert.equal(players.length, 1)
        assert.equal(players[0].id, other.id)
        assert(players[0].name)
        for (const field of ['account', 'gold', 'diamond', 'exp']) assert.equal(players[0][field], undefined)
        f.store.transact(f.session.id, 0, (s) => {
            s.blockedPlayers = [other.id]
        })
        assert.deepEqual(f.call('FriendRecommend')[0].data.player_infos, [])
    } finally {
        f.store.close()
    }
})
test('abyss overview uses configured gates, season window and stored stars only', () => {
    const f = fixture()
    const responseId = protocol.byName.get('CSProtoAbyssGlobalView').id
    const overview = (packets) => {
        const reply = packets.find((packet) => packet.id === responseId)
        assert(reply, 'AbyssGlobalView response must be present')
        return reply.data
    }
    try {
        const first = overview(f.call('AbyssGlobalView'))
        assert.equal(first.mode, 1)
        assert.equal(first.cur_level, 10001)
        assert.equal(first.total_star, 0)
        assert.equal(first.rotation_id, 1)
        f.store.transact(f.session.id, 0, (s) => {
            const done = {}
            for (const m of tables.get('abbys_mode').filter((m) => m.id <= 2))
                for (const id of m.level.split('|').map(Number)) done[id] = { completed: true, stars: 3 }
            s.abyss = {
                cleared_levels: done,
                inherit_notify_flag: true,
                rotations: { 1: { levels: { 30001: { completed: true, stars: 2 } } } },
            }
        })
        const rotation = overview(f.call('AbyssGlobalView', { clear_inherit_flag: true }))
        assert.equal(rotation.mode, 3)
        assert.equal(rotation.cur_level, 30002)
        assert.equal(rotation.total_star, 2)
        assert.equal(rotation.inherit_notify_flag, false)
        f.setTime(configTime(tables.get('abbys_time')[0].endTime))
        const endedPackets = f.call('AbyssGlobalView')
        assert(
            endedPackets.some((packet) => packet.id !== responseId),
            'Cross-day sync precedes the query reply',
        )
        const ended = overview(endedPackets)
        assert.equal(ended.rotation_id, 0)
        assert.equal(ended.mode, 2)
    } finally {
        f.store.close()
    }
})
test('map return restores last-map coordinates and consumes history, with configured fallback', () => {
    const f = fixture()
    try {
        const initial = f.state().world,
            destination = tables.get('world_borthpos').find((p) => p.cityId !== initial.map_id)
        assert(destination)
        f.call('EnterWorldMap', { map_id: destination.cityId, point_id: destination.id })
        assert.equal(f.state().worldHistory.length, 1)
        assert.equal(f.state().world.map_id, destination.cityId)
        const packets = f.call('WorldMapReturnLast')
        assert.equal(f.state().world.map_id, initial.map_id)
        assert.deepEqual(f.state().world.pos, initial.pos)
        assert.equal(f.state().worldHistory.length, 0)
        assert(packets.some((p) => p.id === 9103))
        f.call('WorldMapReturnLast')
        assert.equal(f.state().world.map_id, tables.find('world_borthpos', 10045).cityId)
    } finally {
        f.store.close()
    }
})

test('showcase mode sync precedes reply and persists on relog; invalid mode rolls back', () => {
    const f = fixture()
    try {
        for (const mode of [1, 0]) {
            const output = f.call('ChangeShowcaseType', mode ? { u32: mode } : {})
            assert.equal(output[0].id, protocol.byName.get('CSProtoSyncPlayerData').id)
            assert.equal(output[0].data.basic_info.show_case, mode)
            assert.equal(output.at(-1).id, 6144)
            const login = f.send({}, 'EnterGame', { open_id: 'profile-test' })
            assert.equal(login.find((p) => p.id === 5001).data.data.basic_info.show_case, mode)
        }
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('ChangeShowcaseType', { u32: 2 }))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})
