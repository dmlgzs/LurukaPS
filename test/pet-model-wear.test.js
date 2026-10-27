import test from 'node:test'
import assert from 'node:assert/strict'
import { petModelFixture } from './pet-model-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('6011 refuses an unavailable owned model before rebinding, allows unequip, and keeps both current valid pets usable', () => {
    const f = petModelFixture('pet-model-wear')
    try {
        f.legacyBad()
        const hero = f.state().player.heros_info.heros[0],
            before = f.state()
        assert.throws(
            () => f.call('WearPet', { hero_guid: hero.guid, pet_guid: '500638' }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        f.call('WearPet', { hero_guid: hero.guid, pet_guid: '0' })
        for (const config of [500072, 500261]) {
            const pet = f.owned(config)
            f.call('WearPet', { hero_guid: hero.guid, pet_guid: pet.guid })
            assert.equal(f.state().player.heros_info.heros[0].pet_id, pet.guid)
            assert.equal(f.state().pets.find((row) => row.guid === pet.guid).hero_id, hero.guid)
        }
        assert(f.state().pets.some((pet) => pet.guid === '500638'))
    } finally {
        f.store.close()
    }
})
