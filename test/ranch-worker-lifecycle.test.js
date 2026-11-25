import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchFixture } from './ranch-fixture.js'
import { homeHubStationPets } from '../src/home-hub.js'
import { ErrorCode } from '../src/error-codes.js'

test('current ranch producer slots are independent of a full hub and support same-GUID removal and transfer in both directions', () => {
    const f = ranchFixture('current-ranch-worker-lifecycle', { pets: 18 })
    try {
        const hubs = f.pets.slice(0, 5),
            producers = f.pets.slice(5, 17),
            extra = f.pets[17]
        for (const pet_guid of hubs) f.call('PetStationInHomeHub', { pet_guid, type: 0 })
        for (const [index, guid] of producers.entries()) f.assign(guid, index + 1)
        const ranch = () => f.state().home.ranches[201]
        assert.equal(ranch().product_pets.length, 12)
        assert.deepEqual(homeHubStationPets(f.state()), hubs)
        const full = structuredClone(ranch())
        assert.throws(
            () => f.assign(extra, 13),
            (error) => error.code === ErrorCode.HomeRanchLvPosLimit,
        )
        assert.deepEqual(ranch(), full)

        // Same slot+GUID with a new sequence is the current UI withdrawal.
        f.assign(producers[0], 1)
        assert(!ranch().product_pets.some((row) => row.pet_guid === producers[0]))
        assert.equal(f.state().pets.find((pet) => pet.guid === producers[0]).work_status, 0)
        f.assign(producers[0], 1)
        assert(ranch().product_pets.some((row) => row.pet_guid === producers[0]))

        const before = structuredClone(ranch())
        assert.throws(
            () => f.call('PetStationInHomeHub', { pet_guid: producers[1], type: 0 }),
            (error) => error.code === ErrorCode.HomeHubFull,
        )
        assert.deepEqual(ranch(), before)
        f.call('PetStationInHomeHub', { pet_guid: hubs[0], type: 1 })
        f.store.transact(f.session.id, 0, (state) => {
            const saved = state.home.ranches[201]
            const dropId = saved.product_pets.find((row) => row.pet_guid === producers[1]).drop_times[0].drop_id
            const drop = f.tables.find('home_drop', dropId)
            saved.drops.push({
                guid: saved.nextDropGuid++,
                pet_guid: producers[1],
                drop_id: dropId,
                item: { itemtype: drop.itemType, itemid: Number(drop.itemId), itemnum: 2 },
            })
            saved.stores.push({ itemtype: drop.itemType, itemid: Number(drop.itemId), itemnum: 2 })
            state.pets.find((pet) => pet.guid === producers[1]).labor_infos = [
                { labor_id: 3, labor_grade: 77, upper_labor_grade: 90, labor_exp: 12 },
            ]
        })
        const outputs = { drops: structuredClone(ranch().drops), stores: structuredClone(ranch().stores) }
        const unrelatedClock = structuredClone(ranch().product_pets.find((row) => row.pet_guid === producers[2]))
        const labor = structuredClone(f.state().pets.find((pet) => pet.guid === producers[1]).labor_infos)
        f.call('PetStationInHomeHub', { pet_guid: producers[1], type: 0 })
        assert(!ranch().product_pets.some((row) => row.pet_guid === producers[1]))
        assert(homeHubStationPets(f.state()).includes(producers[1]))
        f.assign(producers[1], 2)
        assert(!homeHubStationPets(f.state()).includes(producers[1]))
        assert.equal(f.state().pets.find((pet) => pet.guid === producers[1]).work_status, 6)
        assert.deepEqual(
            ranch().product_pets.find((row) => row.pet_guid === producers[2]),
            unrelatedClock,
        )
        assert.deepEqual(f.state().pets.find((pet) => pet.guid === producers[1]).labor_infos, labor)
        assert.deepEqual(ranch().drops, outputs.drops)
        assert.deepEqual(ranch().stores, outputs.stores)
    } finally {
        f.close()
    }
})

test('ranch toggle receipts persist in the transaction and distinguish an exact sequence replay from a new click', () => {
    const f = ranchFixture('current-ranch-toggle-receipt')
    try {
        const entry = f.protocol.byName.get('CSProtoRanchSetPetOption')
        const request = { block_id: 201, slot: 1, pet_guid: f.pets[0], work_type: 1 }
        const frame = { id: entry.id, seq: 100000, payload: f.protocol.encode(entry.req, request) }
        f.game.dispatch(f.session, frame)
        const before = structuredClone(f.state().home.ranches[201])
        f.game.dispatch(f.session, frame)
        assert.deepEqual(f.state().home.ranches[201], before)
        f.store.flushPending()
        const saved = JSON.parse(
            f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session.id).state,
        )
        assert(saved.ranchWorkReceipts.length > 0)
        assert.throws(
            () =>
                f.game.dispatch(f.session, {
                    ...frame,
                    payload: f.protocol.encode(entry.req, { ...request, slot: 2 }),
                }),
            (error) => error.code === ErrorCode.InvalidPacket,
        )
        f.game.dispatch(f.session, { ...frame, seq: 100001 })
        assert.equal(f.state().home.ranches[201].product_pets.length, 0)
        f.game.dispatch(f.session, { ...frame, seq: 100001 })
        assert.equal(f.state().home.ranches[201].product_pets.length, 0)
        f.game.dispatch(f.session, { ...frame, seq: 100002 })
        assert.equal(f.state().home.ranches[201].product_pets.length, 1)
    } finally {
        f.close()
    }
})

test('old overlapping hub membership is projected without dropping producers, clocks, inventory or labor', () => {
    const state = {
        home: {
            stationPets: ['1', '2'],
            ranches: {
                201: {
                    product_pets: [{ pet_guid: '1', drop_times: [{ time: 123 }] }],
                    drops: [{ guid: 1 }],
                    stores: [{ itemnum: 2 }],
                },
            },
        },
        pets: [{ guid: '1', labor_infos: [{ labor_grade: 77 }] }],
    }
    const before = structuredClone(state)
    assert.deepEqual(homeHubStationPets(state), ['2'])
    assert.deepEqual(state, before)
})
