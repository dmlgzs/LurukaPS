import test from 'node:test'
import assert from 'node:assert/strict'
import { homeModelFixture } from './pet-model-home-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
test('6162 retains its home prerequisite, rejects bad nonzero activation, and allows producer removal without checking the departing model', () => {
    const f = homeModelFixture('pet-model-ranch')
    try {
        const { ranch, worker } = f.ranch(),
            bad = f.oldBad(),
            request = { block_id: ranch.block_id, work_type: 1, slot: 1, pet_guid: bad.guid },
            before = structuredClone(f.state())
        assert.throws(
            () => f.call('RanchSetPetOption', request),
            (e) => e.code === ErrorCode.GameConfig && /Pet model/.test(e.message),
        )
        assert.deepEqual(f.state(), before)
        f.call('RanchSetPetOption', { ...request, pet_guid: worker })
        assert(f.state().home.ranches[ranch.block_id].product_pets.some((p) => p.pet_guid === worker))
        f.call('RanchSetPetOption', { ...request, pet_guid: '0', out_hub: true })
        assert(!f.state().home.ranches[ranch.block_id].product_pets.some((p) => p.pet_guid === worker))
        assert(f.bad())
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        assert.throws(
            () => f.call('RanchSetPetOption', request),
            (e) => e.code === ErrorCode.PlayerNotInHome,
        )
    } finally {
        f.store.close()
    }
})
