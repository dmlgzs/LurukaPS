import test from 'node:test'
import assert from 'node:assert/strict'
import { petModelFixture } from './pet-model-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('9510 checks current NPC-arena owned pets without changing trial semantics or deleting saved pets', () => {
    const f = petModelFixture('pet-model-npc')
    try {
        f.legacyBad()
        f.call('KiboDuelGetGroup', { u32: 2 })
        const group = structuredClone(f.state().kiboDuelGroups[0]),
            pets = f
                .state()
                .pets.filter((pet) => pet.config_id !== 500638)
                .slice(0, 8)
        assert.equal(pets.length, 8)
        group.pet_guids = pets.map((pet) => ({ id: pet.guid, is_trial: false }))
        group.pet_guids[7].id = '500638'
        f.call('KiboDuelGroupChange', { type: 6, group })
        f.call('SetKiboDuelCurGroup', { type: 6, cur_group: 0 })
        const before = f.state(),
            dungeon = f.tables.find('kibo_duel', 2).dungeonId
        assert.throws(
            () => f.call('MultiCampaignCreate', { dungeon_id: dungeon }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        group.pet_guids[7].id = pets[7].guid
        f.call('KiboDuelGroupChange', { type: 6, group })
        f.call('WearPet', { hero_guid: f.state().player.heros_info.heros[0].guid, pet_guid: '0' })
        f.call('MultiCampaignCreate', { dungeon_id: dungeon })
        assert.equal(f.state().multiCampaign.dungeon_id, dungeon)
        assert(f.state().pets.some((pet) => pet.guid === '500638'))
    } finally {
        f.store.close()
    }
})
