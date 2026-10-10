import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { registerWorld } from '../src/handlers/world.js'
import { registerHome } from '../src/handlers/home.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)

// Mirror the three conditions in CBT3 HeroStore.SyncOneHeroBaseInfo, rather
// than resolving the default from the party control or character config ID.
function clientDefaultHero(player) {
    let guid = '0'
    for (const hero of player.heros_info.heros) {
        const uuid = BigInt(hero.guid)
        if (hero.type === 1 && (uuid & 0xffffffffn) === BigInt(player.basic_info.id) && uuid >> 56n === 1n)
            guid = hero.guid
    }
    return guid
}
function request(game, session, name, body = {}) {
    const entry = protocol.byName.get('CSProto' + name)
    return game
        .dispatch(session, { id: entry.id, seq: 1, pushSeq: 0, payload: protocol.encode(entry.req, body) })
        .map((packet) => ({ id: packet.id, data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload) }))
}

for (const [sex, configId] of [
    [1, 199002],
    [2, 199001],
]) {
    test(`home reconnect repairs HT_MAIN and restores legacy exploration party for sex ${sex}`, () => {
        const store = new Store(':memory:'),
            game = new Game(protocol, store, tables),
            initial = {}
        try {
            request(game, initial, 'EnterGame', { open_id: 'home-main-' + sex })
            let expected
            store.transact(initial.id, 0, (state) => {
                state.characterCustomized = true
                state.player.basic_info.sex = sex
                for (const hero of state.player.heros_info.heros) hero.type = 0
                assert.equal(clientDefaultHero(state.player), '0')
                const manager = state.player.group_mgrs.find((m) => m.type === 1)
                manager.cur_group = 2
                manager.groups[1].heros = state.player.heros_info.heros
                    .slice(0, 3)
                    .map((h) => ({ hero_id: h.guid, pet_id: '0' }))
                manager.groups[1].control = manager.groups[1].heros[2].hero_id
                expected = structuredClone(manager)
                state.homeFormationBackup = structuredClone(manager)
                manager.cur_group = 1
                manager.groups[0].heros = [
                    { hero_id: state.player.heros_info.heros.find((h) => h.conf_id === configId).guid, pet_id: '0' },
                ]
                manager.groups[0].control = manager.groups[0].heros[0].hero_id
                Object.assign(state.world, tables.position(tables.find('world_borthpos', 70101)))
            })
            const session = {},
                packets = request(game, session, 'EnterGame', { open_id: 'home-main-' + sex })
            const player = packets.find((p) => p.id === 5001).data.data
            const main = player.heros_info.heros.find((h) => h.conf_id === configId)
            assert.equal(clientDefaultHero(player), main.guid)
            assert.equal(player.heros_info.heros.filter((h) => h.type === 1).length, 1)
            assert.deepEqual(
                player.group_mgrs.find((m) => m.type === 1),
                expected,
            )
            assert.equal(store.load(session.id).state.homeFormationBackup, undefined)
        } finally {
            store.close()
        }
    })
}

test('generic and explicit home entry register default hero before scene sync without changing exploration lineup', () => {
    for (const route of ['EnterWorldMap', 'EnterHome']) {
        const state = seedPlayer(tables, 7, 'home-entry'),
            handlers = new Map(),
            packets = []
        const manager = state.player.group_mgrs[0],
            group = manager.groups[0]
        group.heros = state.player.heros_info.heros.slice(0, 3).map((h) => ({ hero_id: h.guid, pet_id: '0' }))
        group.control = group.heros[2].hero_id
        const original = structuredClone(manager)
        for (const hero of state.player.heros_info.heros) hero.type = 0
        const push = (name, value) => {
            const e = protocol.byName.get(name)
            packets.push({ name, data: protocol.decode(e.rsp, protocol.encode(e.rsp, value)) })
        }
        const context = { state, tables, id: 7, now: 1000, push, pushBefore: push }
        registerWorld((name, handler) => handlers.set(name, handler))
        registerHome((name, handler) => handlers.set(name, handler), tables)
        handlers.get(route)(context, route === 'EnterHome' ? { creator_id: 7 } : { map_id: 701, point_id: 70101 })
        const heroSync = packets.findIndex((p) => p.name === 'CSProtoSyncPlayerData' && p.data.heros_info)
        const mapSync = packets.findIndex((p) => p.name === 'CSProtoWorldMapSync')
        assert(heroSync >= 0 && heroSync < mapSync)
        assert.notEqual(clientDefaultHero({ ...state.player, heros_info: packets[heroSync].data.heros_info }), '0')
        assert.equal(packets[mapSync].data.map_info.area_id, 701001)
        assert.deepEqual(state.player.group_mgrs[0], original)
        assert.equal(state.homeFormationBackup, undefined)
        handlers.get('WorldQuitHome')(context, {})
        assert.deepEqual(state.player.group_mgrs[0], original)
    }
})

test('character customization publishes one HT_MAIN of the selected sex', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    try {
        const login = request(game, session, 'EnterGame', { open_id: 'main-sex-change' })
        const female = login.find((p) => p.id === 5001).data.data
        assert.equal(female.heros_info.heros.find((h) => h.guid === clientDefaultHero(female)).conf_id, 199001)
        const packets = request(game, session, 'PlayerCustomData', { wardrobe_info: { sex: 1, height: 90 } })
        const sync = packets.find((p) => p.data.heros_info)
        assert(sync)
        const main = sync.data.heros_info.heros.filter((h) => h.type === 1)
        assert.deepEqual(
            main.map((h) => h.conf_id),
            [199002],
        )
    } finally {
        store.close()
    }
})

test('home can edit and select exploration teams without replacing the home default hero', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    const call = (name, body = {}) => request(game, session, name, body)
    try {
        call('EnterGame', { open_id: 'home-edit-formation' })
        call('EnterHome', { creator_id: session.id })
        const before = store.load(session.id).state,
            defaultHero = clientDefaultHero(before.player)
        const selected = before.player.heros_info.heros.slice(0, 2)
        const saved = call('QuickChangeGroupInfo', {
            type: 1,
            id: 2,
            infos: selected.map((hero) => ({ hero_guid: hero.guid, pet_guid: '0' })),
        })
        const groupSync = saved.filter((p) => p.data.group_mgrs?.some((m) => m.type === 1))
        assert.ok(groupSync.length)
        assert.ok(groupSync.every((p) => p.data.group_mgrs.find((m) => m.type === 1).src === 1))
        assert.ok(saved.findIndex((p) => p.data.group_mgrs?.length) < saved.findIndex((p) => p.id === 5981))
        const state = store.load(session.id).state,
            manager = state.player.group_mgrs.find((m) => m.type === 1)
        assert.deepEqual(
            manager.groups.find((g) => g.id === 2).heros.map((h) => h.hero_id),
            selected.map((h) => h.guid),
        )
        assert.equal(clientDefaultHero(state.player), defaultHero)
        assert.deepEqual(state.world.pos, before.world.pos)
        const invalid = store.load(session.id)
        assert.throws(
            () => call('QuickChangeGroupInfo', { type: 1, id: 2, infos: [{ hero_guid: '999', pet_guid: '0' }] }),
            /not owned/,
        )
        assert.deepEqual(store.load(session.id), invalid)
        const switchPackets = call('SwitchWorldGroup', { type: 1, group_id: 2 })
        assert.equal(switchPackets.find((p) => p.data.group_mgrs?.length).data.group_mgrs[0].src, 1)
        assert.equal(store.load(session.id).state.player.group_mgrs.find((m) => m.type === 1).cur_group, 2)
        const controls = call('SwitchWorldGroupControl', { type: 1, control: selected[1].guid })
        assert.equal(controls.find((p) => p.data.group_mgrs?.length).data.group_mgrs[0].src, 1)
        assert.equal(clientDefaultHero(store.load(session.id).state.player), defaultHero)
        assert.deepEqual(store.load(session.id).state.world.pos, before.world.pos)
        call('WorldQuitHome')
        assert.notEqual(store.load(session.id).state.world.map_id, before.world.map_id)
        assert.equal(store.load(session.id).state.player.group_mgrs.find((m) => m.type === 1).cur_group, 2)
        const reconnect = request(game, {}, 'EnterGame', { open_id: 'home-edit-formation', reconnect: true })
        const player = reconnect.find((p) => p.id === 5001).data.data
        assert.equal(player.group_mgrs.find((m) => m.type === 1).cur_group, 2)
        assert.deepEqual(
            player.group_mgrs
                .find((m) => m.type === 1)
                .groups.find((g) => g.id === 2)
                .heros.map((h) => h.hero_id),
            selected.map((h) => h.guid),
        )
    } finally {
        store.close()
    }
})
