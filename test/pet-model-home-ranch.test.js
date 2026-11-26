import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchFixture } from './ranch-fixture.js'
import { createPets } from '../src/pets.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { registerRanch } from '../src/handlers/ranch.js'

function unchanged(f, run, predicate) {
    const before = f.store.load(f.session.id),
        sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
    assert.throws(run, predicate)
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id), sql)
}

test('current500638 owns a real primary model but has no home profile and cannot activate ranch work at home or remotely', () => {
    const f = ranchFixture('pet-model-ranch-profile-current')
    try {
        let owned
        f.store.transact(f.session.id, 0, (state) => {
            owned = createPets(f.tables, state, 500638, 1)[0]
        })
        assert.equal(petModelEligibility(f.tables, 500638).eligible, true)
        assert.equal(f.tables.find('pet_home_talent', 500638), undefined)
        for (const map of [Number(f.tables.get('game').find((row) => row.title === 'HOME_ID').value), 101]) {
            f.store.transact(f.session.id, 0, (state) => {
                state.world.map_id = map
            })
            unchanged(
                f,
                () => f.assign(owned.guid),
                (error) => error.code === ErrorCode.GameConfig && /ranch pet talent configuration/.test(error.message),
            )
        }
        assert(f.state().pets.some((pet) => pet.guid === owned.guid))
    } finally {
        f.close()
    }
})

test('global damaged catalogue remains a wire error while the6162 eligibility context rejects activation and permits explicit withdrawal', () => {
    const f = ranchFixture('pet-model-ranch-gate-current')
    try {
        const worker = f.state().pets.find((pet) => pet.guid === f.pets[0]),
            unitId = f.tables.find('pet', worker.config_id).unitId,
            original = structuredClone(f.tables.find('unit', unitId))
        assert.equal(petModelEligibility(f.tables, worker.config_id).eligible, true)
        // Counterfactual corrupt catalogue for this negative boundary only. Every
        // reference resolves current rows except this primary model; external tables stay intact.
        const damaged = new Proxy(f.tables, {
            get(target, key) {
                if (key === 'get')
                    return (name) =>
                        name === 'unit'
                            ? target.get(name).map((row) => (row.id === unitId ? { ...row, model: '' } : row))
                            : target.get(name)
                if (key === 'find')
                    return (name, id) => {
                        const row = target.find(name, id)
                        return name === 'unit' && Number(id) === unitId ? { ...row, model: '' } : row
                    }
                const value = Reflect.get(target, key)
                return typeof value === 'function' ? value.bind(target) : value
            },
        })
        assert.equal(petModelEligibility(damaged, worker.config_id).eligible, false)
        const game = new Game(f.protocol, f.store, damaged, { clock: () => f.now(), rng: () => 0 }),
            call = (request) => game.dispatch(f.session, f.request('RanchSetPetOption', request)),
            activate = { block_id: 201, work_type: 1, slot: 1, pet_guid: worker.guid }
        for (const map of [Number(f.tables.get('game').find((row) => row.title === 'HOME_ID').value), 101]) {
            f.store.transact(f.session.id, 0, (state) => {
                state.world.map_id = map
            })
            unchanged(
                f,
                () => call(activate),
                (error) => error.code === ErrorCode.GameConfig && /Pet model/.test(error.message),
            )
        }
        f.assign() // Actual6162 with the unmodified current catalogue first establishes the worker.
        assert(f.state().home.ranches[201].product_pets.some((slot) => slot.pet_guid === worker.guid))
        const bag = structuredClone(f.state().player.sbag_infos),
            labor = structuredClone(f.state().pets.find((pet) => pet.guid === worker.guid).labor_infos)
        const withdraw = { ...activate } // Current UI: same GUID and slot with a NEW sequence removes the producer.
        unchanged(
            f,
            () => call(withdraw),
            (error) => error.code === ErrorCode.GameConfig && /Referenced pet model is unavailable/.test(error.message),
        )
        // A current declared model cannot be silently omitted from global wire.
        // Verify the original handler's departing-worker rule separately.
        // This local call has no presentation; healthy-catalogue Game success is checked below.
        const handlers = new Map()
        registerRanch((name, handler) => handlers.set(name, handler), damaged)
        const handler = handlers.get('RanchSetPetOption'),
            privateState = structuredClone(f.state()),
            persisted = f.store.load(f.session.id),
            context = {
                state: privateState,
                tables: damaged,
                now: f.now(),
                randomInt: () => 0,
                activityCatalog: f.game.activities,
                requestKey: 'local-contract-withdraw',
                pushBefore: () => {},
            }
        assert.equal(typeof handler, 'function')
        // Local handler contract, on a private state copy. No default Game is patched,
        // no wire is encoded, and this call is not described as a persisted Game success.
        assert.deepEqual(handler(context, withdraw), {})
        assert(!privateState.home.ranches[201].product_pets.some((slot) => slot.pet_guid === worker.guid))
        const departed = privateState.pets.find((pet) => pet.guid === worker.guid)
        assert(departed)
        assert.equal(departed.work_status, 0)
        assert.equal(departed.work_build, 0)
        assert.deepEqual(departed.labor_infos, labor)
        assert.deepEqual(privateState.player.sbag_infos, bag)
        assert.equal(petModelEligibility(damaged, worker.config_id).eligible, false)
        context.requestKey = 'local-contract-activate'
        const after = structuredClone(privateState)
        assert.throws(
            () => handler(context, activate),
            (error) => error.code === ErrorCode.GameConfig && /Pet model/.test(error.message),
        )
        assert.deepEqual(privateState, after)
        assert.deepEqual(f.store.load(f.session.id), persisted)
        const packets = f.call('RanchSetPetOption', withdraw) // Actual default Game success uses healthy current Tables.
        assert(packets.some((packet) => packet.id === 6162))
        assert(!f.state().home.ranches[201].product_pets.some((slot) => slot.pet_guid === worker.guid))
        assert.deepEqual(f.tables.find('unit', unitId), original)
    } finally {
        f.close()
    }
})
