import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, bytes } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)

function setup() {
    const store = new Store(':memory:')
    let now = 1_790_600_000,
        sequence = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, body = {}, activeSession = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(activeSession, {
                id: entry.id,
                seq: sequence++,
                pushSeq: 0,
                payload: protocol.encode(entry.req, body),
            })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    call('EnterGame', { open_id: 'caress' })
    const target = store.load(session.id).state.pets.find((p) => p.config_id === 500261)
    assert(target)
    return {
        store,
        session,
        target,
        call,
        advance: (seconds) => {
            now += seconds
        },
    }
}

test('legacy pet names are sent before home interaction and custom names remain intact', () => {
    const { store, session, target, call } = setup()
    try {
        store.transact(session.id, 0, (state) => {
            delete state.pets.find((p) => p.guid === target.guid).pet_name
        })
        const reconnect = {}
        const login = call('EnterGame', { open_id: 'caress' }, reconnect)
        const petSync = login.find((packet) => packet.id === protocol.byName.get('CSProtoPetInfoSync').id)
        const named = petSync.data.pet_infos.pets.find((p) => p.guid === target.guid)
        const configName = tables.find('pet', 500261).name
        assert.equal(Buffer.from(named.pet_name, 'base64').toString('utf8'), configName)
        assert.equal(store.load(session.id).state.pets.find((p) => p.guid === target.guid).pet_name, named.pet_name)

        call('PetChangeName', { guid: target.guid, pet_name: bytes('小奇波') }, reconnect)
        const again = {}
        const next = call('EnterGame', { open_id: 'caress' }, again)
        const custom = next
            .find((packet) => packet.id === protocol.byName.get('CSProtoPetInfoSync').id)
            .data.pet_infos.pets.find((p) => p.guid === target.guid)
        assert.equal(Buffer.from(custom.pet_name, 'base64').toString('utf8'), '小奇波')
    } finally {
        store.close()
    }
})

test('home caress acknowledges the client, synchronizes favor first and respects configured daily cap', () => {
    const { store, session, target, call, advance } = setup()
    try {
        call('EnterHome', { creator_id: session.id })
        const first = call('PetCaress', { u64: target.guid })
        const replyId = protocol.byName.get('CSProtoPetCaress').id,
            syncId = protocol.byName.get('CSProtoPetInfoSync').id
        assert(first.findIndex((packet) => packet.id === syncId) < first.findIndex((packet) => packet.id === replyId))
        assert.deepEqual(first.find((packet) => packet.id === replyId).data, {
            pet_guid: target.guid,
            favor_exp_add: 50,
            favor_lv_add: 1,
        })
        let pet = store.load(session.id).state.pets.find((p) => p.guid === target.guid)
        assert.equal(pet.favor_lv, 2)
        assert.equal(pet.favor_val, 0)
        assert.equal(pet.daily_favor_count, 50)
        assert.deepEqual(pet.daily_favor_val, [{ source_type: 4, favor_val: 50 }])

        for (let count = 2; count <= 4; count++) {
            const packets = call('PetCaress', { u64: target.guid })
            assert.equal(packets.find((packet) => packet.id === replyId).data.favor_exp_add, 0)
            pet = store.load(session.id).state.pets.find((p) => p.guid === target.guid)
            assert.equal(pet.daily_favor_count, 50)
        }
        const exhausted = call('PetCaress', { u64: target.guid })
        assert.equal(exhausted.find((packet) => packet.id === replyId).data.favor_exp_add, 0)
        assert.equal(store.load(session.id).state.pets.find((p) => p.guid === target.guid).daily_favor_count, 50)

        advance(86400)
        const refreshed = call('PetCaress', { u64: target.guid })
        assert.equal(refreshed.find((packet) => packet.id === replyId).data.favor_exp_add, 50)
        pet = store.load(session.id).state.pets.find((p) => p.guid === target.guid)
        assert.equal(pet.daily_favor_count, 50)
        assert.equal(pet.favor_lv, 2)
        assert.equal(pet.favor_val, 50)
    } finally {
        store.close()
    }
})

test('caress validates the home scene and owned pet before changing state', () => {
    const { store, session, target, call } = setup()
    try {
        const before = store.load(session.id).state.pets.find((p) => p.guid === target.guid)
        assert.throws(() => call('PetCaress', { u64: target.guid }))
        call('EnterHome', { creator_id: session.id })
        assert.throws(() => call('PetCaress', { u64: '999999999999999' }))
        const after = store.load(session.id).state.pets.find((p) => p.guid === target.guid)
        assert.deepEqual(after, before)
    } finally {
        store.close()
    }
})

test('reconnect after the daily refresh clears the client caress counter', () => {
    const { store, session, target, call, advance } = setup()
    try {
        call('EnterHome', { creator_id: session.id })
        for (let i = 0; i < 4; i++) call('PetCaress', { u64: target.guid })
        advance(86400)
        const reconnect = {},
            packets = call('EnterGame', { open_id: 'caress' }, reconnect)
        const sync = packets.find((packet) => packet.id === protocol.byName.get('CSProtoPetInfoSync').id)
        const pet = sync.data.pet_infos.pets.find((p) => p.guid === target.guid)
        assert.equal(pet.daily_favor_count, 0)
        assert(!pet.daily_favor_val?.some((record) => record.source_type === 4))
        const caress = call('PetCaress', { u64: target.guid }, reconnect)
        assert.equal(
            caress.find((packet) => packet.id === protocol.byName.get('CSProtoPetCaress').id).data.favor_exp_add,
            50,
        )
    } finally {
        store.close()
    }
})
