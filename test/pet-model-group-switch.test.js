import test from 'node:test'
import assert from 'node:assert/strict'
import { petModelFixture } from './pet-model-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('5982 refuses activation of a saved unsafe team before changing the active group', () => {
    const f = petModelFixture('pet-model-group-switch')
    try {
        f.legacyBad()
        const before = f.state()
        assert.throws(
            () => f.call('SwitchWorldGroup', { type: 1, group_id: 2 }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        const pet = f.owned(500072),
            hero = f.state().player.heros_info.heros[0]
        f.call('WearPet', { hero_guid: hero.guid, pet_guid: pet.guid })
        f.call('SwitchWorldGroup', { type: 1, group_id: 2 })
        assert.equal(f.state().player.group_mgrs.find((row) => row.type === 1).cur_group, 2)
    } finally {
        f.store.close()
    }
})
