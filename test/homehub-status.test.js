import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)
function fixture() {
    let now = 1800000000
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    let seq = 1
    const decode = (packet) => ({
            id: packet.id,
            data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        }),
        call = (name, r = {}, who = session) => {
            const e = protocol.byName.get(`CSProto${name}`)
            return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) }).map(decode)
        }
    call('EnterGame', { open_id: 'homehub-status' })
    return {
        store,
        call,
        state: () => store.load(session.id).state,
        session,
        setNow: (value) => {
            now = value
        },
        tick: () => game.tick(session.id).map(decode),
        close: () => store.close(),
    }
}

test('home hub station and exit persist pet status, push updates, and accept stale exit', () => {
    const f = fixture()
    try {
        const id = f.state().pets[0].guid
        assert.deepEqual(
            f.call('PetStationInHomeHub', { pet_guid: id, type: 1 }).map((x) => x.id),
            [6552],
        )
        const stationed = f.call('PetStationInHomeHub', { pet_guid: id, type: 0 })
        assert(stationed.some((x) => x.id === 6102))
        assert(stationed.some((x) => x.id === 6517))
        assert.deepEqual(stationed.find((x) => x.id === 6102).data.home_hub.station_pets, [id])
        assert.equal(f.state().pets.find((p) => p.guid === id).work_status, 7)
        assert.deepEqual(f.state().home.stationPets, [id])
        assert.deepEqual(
            f.call('PetStationInHomeHub', { pet_guid: id, type: 0 }).map((x) => x.id),
            [6552],
        )
        const exited = f.call('PetStationInHomeHub', { pet_guid: id, type: 1 })
        assert.deepEqual(exited.find((x) => x.id === 6102).data.home_hub.station_pets, [])
        assert.equal(f.state().pets.find((p) => p.guid === id).work_status, 0)
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('PetStationInHomeHub', { pet_guid: '999999999', type: 0 }))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})

test('stationing a hero pet clears its ordinary formation slot and respects five unlocked slots', () => {
    const f = fixture()
    try {
        const id = f.state().pets[0].guid,
            hero = f.state().player.heros_info.heros[0].guid
        f.store.transact(f.session.id, 0, (s) => {
            const p = s.pets.find((p) => p.guid === id),
                h = s.player.heros_info.heros[0]
            p.hero_id = h.guid
            h.pet_id = p.guid
            s.player.group_mgrs[0].groups[0].heros[0] = { hero_id: h.guid, pet_id: p.guid }
        })
        // Publish the injected binding to the client before testing its removal.
        f.call('WearPet', { hero_guid: hero, pet_guid: id })
        const packets = f.call('PetStationInHomeHub', { pet_guid: id, type: 0 })
        assert(packets.some((x) => x.id === 5008))
        assert.equal(f.state().player.heros_info.heros[0].pet_id, '0')
        assert.equal(f.state().player.group_mgrs[0].groups[0].heros[0].pet_id, '0')
        for (const p of f.state().pets.slice(1, 5)) f.call('PetStationInHomeHub', { pet_guid: p.guid, type: 0 })
        assert.equal(f.state().home.stationPets.length, 5)
        const before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('PetStationInHomeHub', { pet_guid: f.state().pets[5].guid, type: 0 }),
            /slots are full/,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})

test('mounted pet status survives map sync and normal status clears mount', () => {
    const f = fixture()
    try {
        const id = f.state().pets[0].guid
        const mounted = f.call('WorldMapPlayerStatus', { status: 1, arg: id, doRecord: true })
        assert.deepEqual(
            mounted.filter((x) => x.id === 9103).map((x) => x.data.cmd),
            [17, 25],
        )
        assert.equal(mounted.find((x) => x.id === 9103).data.map_info.players[0].mount, id)
        assert.equal(mounted.find((x) => x.id === 9103).data.map_info.players[0].group, undefined)
        assert.equal(f.state().world.status, 1)
        assert.equal(f.state().world.mount, id)
        const packets = f.call('EnterWorldMap', { map_id: f.state().world.map_id }),
            map = packets.find((x) => x.id === 9103).data
        assert.equal(map.map_info.players[0].status, 1)
        assert.equal(map.map_info.players[0].mount, id)
        f.call('WorldMapPlayerMountStatus', { u32: 5 })
        const dismounted = f.call('WorldMapPlayerStatus', { status: 0, arg: '0', doRecord: true })
        assert.deepEqual(
            dismounted.filter((x) => x.id === 9103).map((x) => x.data.cmd),
            [17, 25],
        )
        assert(dismounted.filter((x) => x.id === 9103).every((x) => x.data.map_info.players[0].move.length === 0))
        assert.equal(f.state().world.status, 0)
        assert.equal(f.state().world.mount, '0')
        assert.equal(f.state().world.mount_status, 0)
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('WorldMapPlayerStatus', { status: 1, arg: '999999999', doRecord: true }))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})

test('login clears only the legacy mount status that lacked a world-map broadcast', () => {
    const f = fixture()
    try {
        const id = f.state().pets[0].guid
        f.store.transact(f.session.id, 0, (s) => {
            s.world.status = 1
            s.world.mount = id
            delete s.world.mountSyncVersion
        })
        const again = {}
        f.call('EnterGame', { open_id: 'homehub-status' }, again)
        assert.equal(f.state().world.status, 0)
        assert.equal(f.state().world.mount, '0')
        f.call('WorldMapPlayerStatus', { status: 1, arg: id, doRecord: true }, again)
        const third = {}
        f.call('EnterGame', { open_id: 'homehub-status' }, third)
        assert.equal(f.state().world.status, 1)
        assert.equal(f.state().world.mount, id)
    } finally {
        f.close()
    }
})

test('remounting after local dismount ACK keeps the new mount state', () => {
    const f = fixture()
    try {
        const id = f.state().pets[0].guid
        f.call('WorldMapPlayerStatus', { status: 1, arg: id, doRecord: true })
        f.call('WorldMapPlayerStatus', { status: 0, arg: '0', doRecord: true })
        f.call('WorldMapPlayerStatus', { status: 1, arg: id, doRecord: true })
        f.setNow(1800000003)
        assert.deepEqual(f.tick(), [])
        assert.equal(f.state().world.status, 1)
        assert.equal(f.state().world.mount, id)
    } finally {
        f.close()
    }
})
