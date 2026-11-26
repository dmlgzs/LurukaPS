import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { createPets } from '../src/pets.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'
import { abyssPetGuid } from '../src/abyss-roster.js'
import { ErrorCode } from '../src/error-codes.js'

test('11451 checks a retained missing-config owned source before making direct or FO31 abyss copies', () => {
    const f = abyssFixture('pet-model-abyss')
    try {
        const normal = f.request()
        assert.equal(petModelEligibility(f.tables, 500638).eligible, true, '500638 is a legitimate current model')
        assert.equal(f.tables.find('pet', 500189), undefined)
        let missingGuid
        f.store.transact(f.session.id, 0, (state) => {
            const imported = createPets(f.tables, state, 500638, 1, 1001, () => 0)[0]
            // Preserve a real canonical instance, with a controlled saved old
            // missing config. The producer never grants an unavailable model.
            imported.config_id = 500189
            missingGuid = imported.guid
        })
        for (const id of [missingGuid, abyssPetGuid(missingGuid)]) {
            const request = f.request()
            request.challenge_list[0].heros[0].hero.pet_guid = id
            const before = f.state()
            assert.throws(
                () => f.call('AbyssChallenge', request),
                (error) => error.code === ErrorCode.PetConfNotExist,
            )
            assert.deepEqual(f.state(), before)
        }
        f.call('AbyssChallenge', normal)
        assert(f.state().abyssRun.pets.length > 0)
        assert(f.state().abyssRun.pets.every((pet) => pet.config_id !== 500189))
        assert.equal(
            f.state().pets.find((pet) => pet.guid === missingGuid).config_id,
            500189,
            'failed deployment preserves the retained owned asset',
        )
    } finally {
        f.store.close()
    }
})
