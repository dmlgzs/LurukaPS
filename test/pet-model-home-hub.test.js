import test from 'node:test'
import assert from 'node:assert/strict'
import { homeModelFixture } from './pet-model-home-fixture.js'
import { repairIdleHomePetModelBindings } from '../src/pet-model-home.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'
import { ErrorCode } from '../src/error-codes.js'

test('6552 refuses invalid-model activation even in the idempotent station branch, permits withdrawal and leaves valid workers usable', () => {
    const f = homeModelFixture('pet-model-homehub')
    try {
        const bad = f.oldBad(),
            before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id)
        assert.throws(
            () => f.call('PetStationInHomeHub', { pet_guid: bad.guid, type: 0 }),
            (e) => e.code === ErrorCode.GameConfig && /Pet model/.test(e.message),
        )
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.store.transact(f.session.id, 0, (s) => {
            ;(s.home.stationPets ??= []).push(bad.guid)
            Object.assign(
                s.pets.find((p) => p.guid === bad.guid),
                { work_status: 7 },
            )
        })
        assert.throws(() => f.call('PetStationInHomeHub', { pet_guid: bad.guid, type: 0 }), /Pet model/)
        f.call('PetStationInHomeHub', { pet_guid: bad.guid, type: 1 })
        assert.equal(f.bad().work_status, 0)
        assert(f.bad())
        assert(!f.state().home.stationPets.includes(bad.guid))
        const valid = f.state().pets.find((p) => !p.work_status && petModelEligibility(f.tables, p.config_id).eligible)
        f.call('PetStationInHomeHub', { pet_guid: valid.guid, type: 0 })
        assert(f.state().home.stationPets.includes(valid.guid))
        f.call('PetStationInHomeHub', { pet_guid: valid.guid, type: 1 })
        assert(!f.state().home.stationPets.includes(valid.guid))
    } finally {
        f.store.close()
    }
})

test('idle home model repair preserves owned inventory, claimed data and unrelated jobs; busy or referenced workers are diagnosed rather than cancelled', () => {
    const f = homeModelFixture('pet-model-home-repair-pure')
    try {
        f.oldBad()
        const check = (tables, cfg) => petModelEligibility(tables, cfg).eligible,
            original = structuredClone(f.state()),
            bare = { pets: original.pets }
        assert.equal(repairIdleHomePetModelBindings(f.tables, bare, check), false)
        assert.equal(bare.home, undefined)
        for (const status of [0, 7]) {
            const s = structuredClone(original),
                p = s.pets.find((p) => p.guid === '500638')
            Object.assign(p, { work_status: status, work_build: status ? 123 : 777, capacity_id: status ? 999 : 888 })
            s.home.stationPets = [p.guid]
            // Synthetic compatibility payload: preservation only, not claimed as real produced rewards.
            s.home.keptClaimed = { seen: [1, 2], rewards: [3] }
            const kept = structuredClone({
                    bag: s.player.sbag_infos,
                    pet: p,
                    builds: s.home.builds,
                    ranches: s.home.ranches,
                    claims: s.home.keptClaimed,
                }),
                revision = s.homeRevision ?? 0
            assert.equal(repairIdleHomePetModelBindings(f.tables, s, check), true)
            assert.deepEqual(s.player.sbag_infos, kept.bag)
            assert.deepEqual(s.home.builds, kept.builds)
            assert.deepEqual(s.home.ranches, kept.ranches)
            assert.deepEqual(s.home.keptClaimed, kept.claims)
            assert(!s.home.stationPets.includes(p.guid))
            assert.equal(s.homeRevision, revision + 1)
            if (status === 0) assert.deepEqual(p, kept.pet)
            else assert.deepEqual(p, { ...kept.pet, work_status: 0, work_build: 0, capacity_id: 0 })
            assert.equal(repairIdleHomePetModelBindings(f.tables, s, check), false)
        }
        for (const field of ['production', 'farm', 'ranch', 'busy']) {
            const s = structuredClone(original),
                p = s.pets.find((p) => p.guid === '500638')
            s.home.stationPets = [p.guid]
            p.work_status = field === 'busy' ? 6 : 7
            if (field === 'production') s.home.builds.push({ station_pet_guid: p.guid, stock: [{ item: 1 }] })
            if (field === 'farm') s.home.builds.push({ auto_info: { plant_pet: p.guid, crops: [{ quantity: 3 }] } })
            if (field === 'ranch')
                s.home.ranches.synthetic = {
                    product_pets: [{ pet_guid: p.guid, drop_times: [{ time: 1 }] }],
                    stores: [{ itemnum: 2 }],
                }
            const before = structuredClone(s)
            assert.equal(repairIdleHomePetModelBindings(f.tables, s, check), false)
            assert.deepEqual(s, before)
        }
    } finally {
        f.store.close()
    }
})
