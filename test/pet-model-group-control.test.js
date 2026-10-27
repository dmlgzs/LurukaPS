import test from 'node:test'
import assert from 'node:assert/strict'
import { petModelFixture } from './pet-model-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('5983 does not switch normal control while the activated team retains an unavailable pet model', () => {
    const f = petModelFixture('pet-model-group-control')
    try {
        f.legacyBad()
        const heroes = f.state().player.heros_info.heros.slice(0, 2)
        f.store.transact(f.session.id, 0, (state) => {
            state.player.group_mgrs.find((row) => row.type === 1).groups[0].heros[1] = {
                hero_id: heroes[1].guid,
                pet_id: '0',
            }
        })
        const before = f.state()
        assert.throws(
            () => f.call('SwitchWorldGroupControl', { type: 1, control: heroes[1].guid }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        f.call('WearPet', { hero_guid: heroes[0].guid, pet_guid: '0' })
        f.call('SwitchWorldGroupControl', { type: 1, control: heroes[1].guid })
        assert.equal(f.state().player.group_mgrs.find((row) => row.type === 1).groups[0].control, heroes[1].guid)
    } finally {
        f.store.close()
    }
})
