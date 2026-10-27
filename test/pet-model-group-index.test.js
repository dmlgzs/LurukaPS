import test from 'node:test'
import assert from 'node:assert/strict'
import { petModelFixture } from './pet-model-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('5980 checks the effective owned binding even if the incoming group omits its pet', () => {
    const f = petModelFixture('pet-model-group-index')
    try {
        f.legacyBad()
        const hero = f.state().player.heros_info.heros[0],
            request = { type: 1, group: { id: 1, control: hero.guid, heros: [{ hero_id: hero.guid, pet_id: '0' }] } },
            before = f.state()
        assert.throws(
            () => f.call('ChangeHeroGroupIndex', request),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        const pet = f.owned(500261)
        f.call('WearPet', { hero_guid: hero.guid, pet_guid: pet.guid })
        f.call('ChangeHeroGroupIndex', request)
        assert.equal(f.state().player.group_mgrs.find((row) => row.type === 1).groups[0].heros[0].pet_id, pet.guid)
    } finally {
        f.store.close()
    }
})
