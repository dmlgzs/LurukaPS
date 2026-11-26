import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets, createPetFromSpecimen, petData } from '../src/pets.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { isStarterPet, repairPetCatalog } from '../src/pet-catalog.js'
import {
    parsePetGuid,
    permanentPetGuid,
    isCanonicalPetGuid,
    planPetGuidAllocation,
    commitPetGuidAllocation,
    petGuidAllocationFloor,
} from '../src/pet-guid.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const blank = (owner = 19) => ({ player: { basic_info: { id: owner } }, pets: [] })
const nativeOwned = (guid, owner) => {
    const id = BigInt(guid)
    return id >> 56n === 2n && Number(id & 0xffffffffn) === owner
}
const configError = (error) => error.code === ErrorCode.GameConfig

test('current Native identity contract uses type2, independent24-bit instance, actual low32 owner', () => {
    const guids = new Set()
    for (const owner of [1, 2, 0xffffffff])
        for (const index of [1, 501019, 0xffffff]) {
            const guid = permanentPetGuid(owner, index)
            assert.deepEqual(parsePetGuid(guid), { guid, type: 2, index, ownerId: owner })
            assert.ok(nativeOwned(guid, owner))
            guids.add(guid)
        }
    assert.equal(guids.size, 9)
    for (const bad of [0, -1, 0x1000000, 1.5]) assert.throws(() => permanentPetGuid(1, bad), configError)
    for (const bad of [0, -1, 0x100000000, 1.5]) assert.throws(() => permanentPetGuid(bad, 1), configError)
    for (const bad of [-1, '18446744073709551616', 'broken', Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() => parsePetGuid(bad), configError)
})

test('all current starter profiles are Native owned across accounts and keep free-source catalog semantics', () => {
    const one = seedPlayer(tables, 1, 'guid-seed-one'),
        two = seedPlayer(tables, 2, 'guid-seed-two')
    assert.equal(one.pets.length, 210)
    const first = new Set(one.pets.map((pet) => pet.guid))
    assert.equal(first.size, 210)
    for (const state of [one, two]) {
        assert.ok(state.pets.every((pet) => nativeOwned(pet.guid, state.player.basic_info.id)))
        assert.ok(state.pets.every((pet) => isStarterPet(pet, state)))
        state.recordPets = state.pets.map((pet) => pet.config_id)
        delete state.petCatalogVersion
        repairPetCatalog(tables, state)
        assert.deepEqual(state.recordPets, [])
        assert.equal(Object.keys(state.petProvenance.entries).length, 210)
        assert.deepEqual(Object.keys(state.petGuidAllocation).sort(), ['nextIndex', 'ownerId', 'version'])
        const payload = { pet_infos: { pets: state.pets }, record_pets: state.recordPets }
        const type = protocol.byName.get('CSProtoPetInfoSync').rsp
        const wire = protocol.decode(type, protocol.encode(type, payload))
        assert.equal(wire.pet_infos.pets.length, 210)
    }
    assert.ok(two.pets.every((pet) => !first.has(pet.guid)))
    const starter = one.pets[0],
        birth = starter.config_id
    starter.config_id = one.pets[1].config_id
    assert.equal(isStarterPet(starter, one), false, 'new species on evolution retains prior acquisition policy')
    assert.equal(one.petProvenance.entries[starter.guid].configId, birth)
})

test('planning is pure, persists compact highwater, and never recycles released acquired identities', () => {
    const state = blank(),
        before = structuredClone(state)
    state.nextPetSequence = 0xffffffff
    const expected = structuredClone(state),
        plan = planPetGuidAllocation(tables, state, 2)
    assert.deepEqual(state, expected)
    assert.equal(parsePetGuid(plan.guids[0]).index, 501019)
    commitPetGuidAllocation(state, plan, 'acquired', [500001, 500001])
    assert.deepEqual(state.petProvenance.entries, {})
    assert.equal(state.nextPetSequence, 0xffffffff, 'obsolete low32 sequence is not the24-bit allocator')
    for (let i = 0; i < 100; i++) {
        const next = planPetGuidAllocation(tables, state, 1)
        assert.ok(!plan.guids.includes(next.guids[0]))
        commitPetGuidAllocation(state, next, 'acquired', [500001])
    }
    assert.equal(state.petGuidAllocation.nextIndex, 501121)
    assert.deepEqual(state.petProvenance.entries, {})
    assert.equal(state.pets.length, before.pets.length)
    assert.throws(() => commitPetGuidAllocation(state, plan, 'acquired', [500001, 500001]), configError)
})

test('all known acquisition/released receipt roots reserve canonical middle bits without changing pending data', () => {
    const sources = [
        (s, guid) => s.pets.push({ guid }),
        (s, guid) => (s.petStarSoulProgress = { entries: { [guid]: { configId: 500001 } } }),
        (s, guid) => (s.hatchReceipts = { egg: { petGuid: guid } }),
        (s, guid) => (s.petCaptureResults = { enemy: { guid, pet_id: 500001 } }),
        (s, guid) => (s.playableChoiceReceipts = { choice: { pet_guid: guid } }),
        (s, guid) => (s.petMutation = { pets: { [guid]: { pending: { petGuid: guid, baseHash: 'keep' } } } }),
        (s, guid) => (s.petMutation = { claimResults: { paid: { pets: [{ pet_guid: guid }] } } }),
    ]
    for (const put of sources) {
        const state = blank(),
            historical = permanentPetGuid(19, 700000)
        put(state, historical)
        const before = structuredClone(state),
            plan = planPetGuidAllocation(tables, state, 1)
        assert.equal(parsePetGuid(plan.guids[0]).index, 700001)
        assert.deepEqual(state, before)
        commitPetGuidAllocation(state, plan, 'acquired', [500575])
        assert.equal(state.petGuidAllocation.nextIndex, 700002)
        for (const key of Object.keys(before)) assert.deepEqual(state[key], before[key])
    }
})

test('existing canonical identity is preserved, unrelated owner and trial GUIDs do not alter instance namespace', () => {
    const state = blank(),
        canonical = permanentPetGuid(19, 800000)
    state.pets = [
        { guid: canonical },
        { guid: permanentPetGuid(20, 900000) },
        { guid: String((9n << 56n) | (0xfffffen << 32n) | 19n) },
    ]
    const before = structuredClone(state.pets),
        plan = planPetGuidAllocation(tables, state, 1)
    assert.equal(parsePetGuid(plan.guids[0]).index, 800001)
    commitPetGuidAllocation(state, plan, 'acquired', [500001])
    assert.deepEqual(state.pets, before)
    assert.ok(isCanonicalPetGuid(canonical, 19))
})

test('explicit damaged allocator/source and24-bit exhaustion fail without mutation; absent metadata remains valid', () => {
    const state = blank()
    assert.equal(petGuidAllocationFloor(tables, state), 501019)
    for (const saved of [
        null,
        {},
        { version: 1, ownerId: 20, nextIndex: 501019 },
        { version: 1, ownerId: 19, nextIndex: 0 },
        { version: 1, ownerId: 19, nextIndex: 0x1000001 },
    ]) {
        const bad = { ...blank(), petGuidAllocation: saved },
            before = structuredClone(bad)
        assert.throws(() => planPetGuidAllocation(tables, bad, 1), configError)
        assert.deepEqual(bad, before)
    }
    const full = { ...blank(), petGuidAllocation: { version: 1, ownerId: 19, nextIndex: 0xffffff } }
    const last = planPetGuidAllocation(tables, full, 1)
    commitPetGuidAllocation(full, last, 'acquired', [500001])
    const before = structuredClone(full)
    assert.throws(() => planPetGuidAllocation(tables, full, 1), configError)
    assert.deepEqual(full, before)
    const damaged = { ...blank(), petProvenance: { version: 1, ownerId: 19, entries: { bad: {} } } }
    assert.throws(() => planPetGuidAllocation(tables, damaged, 1), configError)
})

test('no-provenance legacy starter identity still uses old exact equality until typed migration', () => {
    const state = blank()
    assert.equal(isStarterPet({ guid: '500001', config_id: 500001 }, state), true)
    assert.equal(isStarterPet({ guid: permanentPetGuid(19, 500001), config_id: 500001 }, state), false)
})

test('real memory Game login, normal WearPet and reconnect preserve canonical starter identity and source', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const call = (name, payload) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: row.id, seq: seq++, payload: protocol.encode(row.req, payload) })
    }
    try {
        const packets = call('EnterGame', { open_id: 'canonical-starter-entry' })
        const state = store.load(session.id).state,
            guid = state.pets.find((pet) => pet.config_id === 500001).guid
        const hero = state.player.heros_info.heros.find((row) => row.type === 1)
        const petWire = protocol.byName.get('CSProtoPetInfoSync').rsp
        const shown = packets
            .filter((row) => row.id === 6517)
            .flatMap((row) => protocol.decode(petWire, row.payload).pet_infos.pets)
        assert.equal(shown.length, state.pets.length)
        assert.ok(shown.every((pet) => nativeOwned(pet.guid, session.id)))
        call('WearPet', { hero_guid: hero.guid, pet_guid: guid })
        const worn = store.load(session.id).state
        assert.equal(worn.player.heros_info.heros.find((row) => row.guid === hero.guid).pet_id, guid)
        assert.equal(worn.pets.find((pet) => pet.guid === guid).hero_id, hero.guid)
        const identity = structuredClone({ allocation: worn.petGuidAllocation, provenance: worn.petProvenance })
        session = {}
        call('EnterGame', { open_id: 'canonical-starter-entry', reconnect: true })
        const reentered = store.load(session.id).state
        assert.equal(reentered.pets.find((pet) => pet.config_id === 500001).guid, guid)
        assert.deepEqual({ allocation: reentered.petGuidAllocation, provenance: reentered.petProvenance }, identity)
        assert.deepEqual(reentered.recordPets, [])
    } finally {
        store.close()
    }
})

test('real ordinary, gift, customized and published-specimen creators share canonical allocation without rerolling specimens', () => {
    const accounts = [seedPlayer(tables, 1, 'guid-created-one'), seedPlayer(tables, 2, 'guid-created-two')]
    const issued = new Set()
    for (const state of accounts) {
        const starters = state.pets.map((pet) => pet.guid),
            provenance = structuredClone(state.petProvenance)
        const direct = createPets(tables, state, 500001, 2, 1001, () => 0)
        const paid = grantRewards(tables, state, [
            { itemtype: 5, itemid: 500001, itemnum: 2 },
            { itemtype: 30, itemid: 5002611, itemnum: 1 },
        ])
        const preview = petData(tables, 500001, '0', 0, 1001, () => 0),
            original = structuredClone(preview)
        const specimen = createPetFromSpecimen(tables, state, preview)
        assert.deepEqual(preview, original)
        assert.deepEqual({ ...specimen, guid: '0', box_id: 0 }, original)
        assert.equal(paid.length, 3)
        assert.equal(new Set(direct.map((pet) => pet.guid)).size, 2)
        assert.deepEqual(
            state.pets.slice(0, starters.length).map((pet) => pet.guid),
            starters,
        )
        for (const pet of state.pets) {
            assert.ok(nativeOwned(pet.guid, state.player.basic_info.id))
            assert.ok(!issued.has(pet.guid))
            issued.add(pet.guid)
        }
        assert.deepEqual(
            state.petProvenance,
            provenance,
            'ordinary acquired identities do not grow exception provenance',
        )
        assert.ok(state.recordPets.includes(500001))
        const nextIndex = state.petGuidAllocation.nextIndex
        state.pets = []
        const afterRelease = createPets(tables, state, 500001, 1, 1001, () => 0)[0]
        assert.equal(parsePetGuid(afterRelease.guid).index, nextIndex)
        assert.ok(!issued.has(afterRelease.guid))
    }
})

test('real Game codec failure rolls allocation and source back before a deterministic retry', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    const session = {},
        row = protocol.byName.get('CSProtoGMCommand')
    let seq = 1
    const call = (name, payload) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, payload) })
    }
    const command = { command: Buffer.from('give 5 500001 2').toString('base64') }
    try {
        call('EnterGame', { open_id: 'canonical-creation-rollback' })
        const before = store.load(session.id),
            encode = protocol.encode
        try {
            protocol.encode = function (name, payload) {
                if (name === row.rsp) throw Error('GUID allocation codec rollback probe')
                return encode.call(this, name, payload)
            }
            assert.throws(() => call('GMCommand', command), /GUID allocation codec rollback probe/)
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(store.load(session.id), before)
        call('GMCommand', command)
        const after = store.load(session.id).state,
            added = after.pets.slice(before.state.pets.length)
        assert.equal(added.length, 2)
        assert.deepEqual(
            added.map((pet) => parsePetGuid(pet.guid).index),
            [before.state.petGuidAllocation.nextIndex, before.state.petGuidAllocation.nextIndex + 1],
        )
        assert.ok(added.every((pet) => nativeOwned(pet.guid, session.id)))
        assert.deepEqual(after.petProvenance, before.state.petProvenance)
    } finally {
        store.close()
    }
})
