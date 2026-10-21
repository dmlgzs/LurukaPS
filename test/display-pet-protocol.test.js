import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('6138 persists four-slot pet showcase separately from heroes and rejects invalid or foreign selections atomically', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'display-pet' })
        const hero = state().player.heros_info.heros[0]
        call('ChangeShowHero', { hero: [{ hero_id: hero.guid, pos: 1 }] })
        const beforeHeroes = structuredClone(state().player.basic_info.info.hero)
        const pets = state().pets.slice(0, 4)
        const packets = call('ChangeShowPet', {
            pet: pets.map((pet, i) => ({ pet_guid: pet.guid, pos: i + 1 })).reverse(),
        })
        assert.equal(packets.at(-1).id, 6138)
        assert.ok(packets.slice(0, -1).some((packet) => packet.id === protocol.byName.get('CSProtoSyncPlayerData').id))
        const shown = state().player.basic_info.info.pet
        assert.deepEqual(
            shown,
            pets.map((pet, i) => ({ guid: pet.guid, id: pet.config_id, lv: pet.lv, pos: i + 1 })),
        )
        assert.deepEqual(store.publicProfiles(-1).find((profile) => profile.id === session.id).info.pet, shown)
        for (const pet of [
            [{ pet_guid: pets[0].guid, pos: 0 }],
            [{ pet_guid: pets[0].guid, pos: 5 }],
            [
                { pet_guid: pets[0].guid, pos: 1 },
                { pet_guid: pets[1].guid, pos: 1 },
            ],
            [
                { pet_guid: pets[0].guid, pos: 1 },
                { pet_guid: pets[0].guid, pos: 2 },
            ],
        ]) {
            const before = structuredClone(state())
            assert.throws(() => call('ChangeShowPet', { pet }))
            assert.deepEqual(state(), before)
        }
        assert.throws(
            () => call('ChangeShowPet', { pet: [{ pet_guid: '99999999', pos: 1 }] }),
            (error) => error.code === ErrorCode.PetNotExist,
        )
        const enter = protocol.byName.get('CSProtoEnterGame')
        game.dispatch({}, { id: enter.id, seq: seq++, payload: protocol.encode(enter.req, { open_id: 'display-pet' }) })
        assert.deepEqual(state().player.basic_info.info.pet, shown)
        call('ChangeShowPet', { pet: [] })
        assert.deepEqual(state().player.basic_info.info.pet, [])
        assert.deepEqual(state().player.basic_info.info.hero, beforeHeroes)
    } finally {
        store.close()
    }
})
