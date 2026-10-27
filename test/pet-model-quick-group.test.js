import test from 'node:test'
import assert from 'node:assert/strict'
import { petModelFixture } from './pet-model-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('5981 validates every requested owned model before any batch swap and accepts both valid controls', () => {
    const f = petModelFixture('pet-model-quick')
    try {
        f.legacyBad()
        const one = f.owned(500072),
            two = f.owned(500261),
            heroes = f.state().player.heros_info.heros.slice(0, 2),
            request = {
                type: 1,
                id: 1,
                infos: [
                    { hero_guid: heroes[0].guid, pet_guid: one.guid },
                    { hero_guid: heroes[1].guid, pet_guid: '500638' },
                ],
            },
            before = f.state()
        assert.throws(
            () => f.call('QuickChangeGroupInfo', request),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        request.infos[1].pet_guid = two.guid
        f.call('QuickChangeGroupInfo', request)
        const group = f
            .state()
            .player.group_mgrs.find((row) => row.type === 1)
            .groups.find((row) => row.id === 1)
        assert.deepEqual(
            group.heros.map((slot) => slot.pet_id),
            [one.guid, two.guid],
        )
    } finally {
        f.store.close()
    }
})
