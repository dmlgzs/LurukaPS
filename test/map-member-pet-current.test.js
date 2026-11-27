import test from 'node:test'
import assert from 'node:assert/strict'
import { targetFixture, protocol, tables } from './team-v2-target-change-fixture.js'
import { currentMapMember } from '../src/current-map-member.js'
import { teamV2MemberData } from '../src/team-v2-member.js'
import { ErrorCode } from '../src/error-codes.js'

test('actual material entry and scene refresh retain the bound pet in the current base-info message without rewriting its identity', () => {
    const f = targetFixture({ count: 1 }),
        b64 = (value) => Buffer.from(String(value)).toString('base64'),
        member = (packets) => {
            const entry = protocol.byName.get('CSProtoMultiCampaignBaseInfoSync'),
                packet = packets.find((packet) => packet.id === entry.id)
            assert(packet, 'Current dungeon entry/refresh must send its base-info message')
            return protocol.decode(entry.rsp, packet.payload).player_list[0]
        }
    try {
        // Explicit GM grant in a prepared normal-account menu fixture; not
        // a naturally earned pet or a full story/prerequisite replay.
        f.call(0, 'GMCommand', { command: b64('give'), args: [5, 500001, 1].map(b64) })
        const pet = f.state(0).pets.find((row) => row.config_id === 500001),
            hero = f.state(0).player.heros_info.heros[0]
        assert(pet && hero)
        f.call(0, 'WearPet', { hero_guid: hero.guid, pet_guid: pet.guid })
        const beforePets = structuredClone(f.state(0).pets),
            beforeGroups = structuredClone(f.state(0).player.group_mgrs),
            expected = {
                pet_id: pet.config_id,
                level: pet.lv,
                special: pet.special ?? 0,
                color: pet.color ?? 0,
                colorful: pet.colorful ?? 0,
            },
            dungeon = tables.find('dungeon_material', 10101)
        const entry = member(f.call(0, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })),
            selected = entry.data.group.hero_list.find((row) => row.hero_id === hero.conf_id)
        assert.deepEqual(selected.pet, expected)
        // Current SetTeamData060015bd zeroes pet fields first and only copies
        // petId/color/special when TeamV2Hero.pet is present. This projection
        // models that consumer from the decoded wire, not Unity rendering.
        const display = selected.pet
            ? {
                  petId: selected.pet.pet_id,
                  color: selected.pet.color,
                  special: selected.pet.special,
              }
            : { petId: 0, color: 0, special: 0 }
        assert.equal(display.petId, pet.config_id)
        assert.notEqual(String(display.petId), pet.guid)
        assert.equal(pet.feature, 1)
        assert.equal(display.special, 0, 'feature1 does not imply special1')
        const refreshed = member(
            f.call(0, 'EnterDungeonScene', {
                scene_id: f.state(0).world.map_id,
                creator_id: f.id(0),
            }),
        )
        assert.deepEqual(refreshed.data.group, entry.data.group)
        assert.deepEqual(f.state(0).pets, beforePets)
        assert.deepEqual(f.state(0).player.group_mgrs, beforeGroups)
        assert.deepEqual(teamV2MemberData(f.state(0), f.id(0)), currentMapMember(f.state(0), f.id(0)).data)
        const damaged = structuredClone(f.state(0))
        damaged.pets.find((row) => row.guid === pet.guid).special = '1'
        assert.throws(
            () => currentMapMember(damaged, f.id(0)),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.equal(damaged.pets.find((row) => row.guid === pet.guid).special, '1')
    } finally {
        f.close()
    }
})
