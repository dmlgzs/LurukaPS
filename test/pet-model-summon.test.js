import test from 'node:test'
import assert from 'node:assert/strict'
import { petModelFixture } from './pet-model-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('11061 refuses unsafe owned presentation before recording or broadcasting it and accepts a normal pet', () => {
    const f = petModelFixture('pet-model-summon')
    try {
        f.legacyBad()
        const before = f.state()
        assert.throws(
            () => f.call('SwitchPetAction', { uuid: '500638', type: 1 }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        const pet = f.owned(500261)
        f.call('SwitchPetAction', { uuid: pet.guid, type: 1 })
        assert.equal(f.state().combat.petPresentation[pet.guid].type, 1)
    } finally {
        f.store.close()
    }
})
