import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { petData } from '../src/pets.js'
import { abyssPetGuid } from '../src/abyss-roster.js'
import { ErrorCode } from '../src/error-codes.js'

test('11451 checks the original owned model before making either legacy or FO31 abyss copies', () => {
    const f = abyssFixture('pet-model-abyss')
    try {
        const normal = f.request()
        f.store.transact(f.session.id, 0, (state) => {
            state.pets.push(petData(f.tables, 500638, '500638', 2999, undefined, () => 0))
        })
        for (const id of ['500638', abyssPetGuid('500638')]) {
            const request = f.request()
            request.challenge_list[0].heros[0].hero.pet_guid = id
            const before = f.state()
            assert.throws(
                () => f.call('AbyssChallenge', request),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), before)
        }
        f.call('AbyssChallenge', normal)
        assert(f.state().abyssRun.pets.length > 0)
        assert(f.state().abyssRun.pets.every((pet) => pet.config_id !== 500638))
    } finally {
        f.store.close()
    }
})
