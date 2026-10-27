import test from 'node:test'
import assert from 'node:assert/strict'
import { homeModelFixture } from './pet-model-home-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
test('6532 rejects nonzero bad-model dispatch before labor changes and preserves current-pet/zero withdrawal channels', () => {
    const f = homeModelFixture('pet-model-production')
    try {
        const { guid, worker } = f.production(),
            bad = f.oldBad(),
            request = { build_guid: guid, build_type: 2, sub_work_type: 0, pet_guid: bad.guid },
            before = structuredClone(f.state())
        assert.throws(
            () => f.call('PetStationed', request),
            (e) => e.code === ErrorCode.GameConfig && /Pet model/.test(e.message),
        )
        assert.deepEqual(f.state(), before)
        f.call('PetStationed', { ...request, pet_guid: worker })
        assert.equal(f.state().home.builds.find((b) => b.guid === guid).station_pet_guid, worker)
        f.call('PetStationed', { ...request, pet_guid: worker })
        assert.equal(f.state().home.builds.find((b) => b.guid === guid).station_pet_guid, '0')
        f.call('PetStationed', { ...request, pet_guid: '0' })
        assert(f.bad())
    } finally {
        f.store.close()
    }
})
