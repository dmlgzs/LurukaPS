import test from 'node:test'
import assert from 'node:assert/strict'
import { targetFixture, tables, protocol } from './team-v2-target-change-fixture.js'
import { gmHeroRewards } from '../src/gm-roster-catalogue.js'

test('shared map reconstruction sends distinct real actors, aligned pets and peer attributes without changing owned identity or peer state', () => {
    const f = targetFixture({ count: 2 }),
        teams = f.game.teamV2,
        runs = teams.runs,
        b64 = (value) => Buffer.from(String(value)).toString('base64'),
        idOf = (name) => protocol.byName.get('CSProto' + name).id,
        decode = (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload)
    const transaction = (fn) =>
        f.store.transact(
            f.id(0),
            0,
            (state, tx) =>
                fn({
                    id: f.id(0),
                    state,
                    tables,
                    now: f.now(),
                    combatSessionId: f.sessions[0].token,
                    editPlayer: tx.editPlayer,
                    pushBefore: (name, value) => f.game.packet(name, value),
                    pushTo: (recipient, name, value) => f.game.packet(name, value, { recipient }),
                }),
            { skipUnchanged: true },
        )
    try {
        // Explicit current GM assets and menu qualification,not naturally
        // earned story progress. All actual grants/bindings use public paths.
        const gift = gmHeroRewards(tables, f.state(0))[0]
        f.call(0, 'GMCommand', { command: b64('give'), args: [1, gift.itemid, 1].map(b64) })
        f.call(0, 'GMCommand', { command: b64('give'), args: [5, 500001, 1].map(b64) })
        f.call(1, 'GMCommand', { command: b64('give'), args: [5, 500001, 1].map(b64) })
        const hero0 = f.state(0).player.heros_info.heros[0],
            hero1 = f.state(1).player.heros_info.heros[0],
            extra = f.state(0).player.heros_info.heros.find((hero) => hero.conf_id === gift.itemid),
            pet0 = f.state(0).pets.find((pet) => pet.config_id === 500001),
            pet1 = f.state(1).pets.find((pet) => pet.config_id === 500001),
            manager = f.state(0).player.group_mgrs.find((entry) => entry.type === 1)
        assert.equal(hero0.conf_id, hero1.conf_id)
        assert.notEqual(hero0.guid, hero1.guid)
        assert.notEqual(pet0.guid, pet1.guid)
        f.call(0, 'QuickChangeGroupInfo', {
            type: 1,
            id: manager.cur_group,
            infos: [
                { hero_guid: hero0.guid, pet_guid: '0' },
                { hero_guid: extra.guid, pet_guid: pet0.guid },
            ],
        })
        f.call(1, 'WearPet', { hero_guid: hero1.guid, pet_guid: pet1.guid })
        f.create()
        // Internal phase checkpoints isolate scene reconstruction. This does
        // not produce a public Ready/Start,load barrier or shared combat run.
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 3, ready: [f.id(0), f.id(1)] }, 0))
        transaction((c) => runs.admit(c, f.room()))
        const dungeon = tables.find('dungeon_material', 10101)
        f.call(0, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })
        f.call(1, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })
        transaction((c) => runs.bindScenes(c))
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 4 }, 0))
        const peer = f.store.playerById.get(f.id(1)),
            peerState = structuredClone(f.state(1)),
            peerToken = f.store.readCacheToken(f.id(1)),
            packets = f.call(0, 'EnterDungeonScene', { scene_id: f.state(0).world.map_id }),
            mapIndex = packets.findIndex((packet) => packet.id === idOf('WorldMapSync') && decode(packet).cmd === 256),
            map = decode(packets[mapIndex])
        assert.deepEqual(
            map.map_info.players.map((player) => player.player_id),
            [f.id(0), f.id(1)],
        )
        assert.equal(map.creator_id, f.id(0))
        assert.equal(map.map_info.creator_id, f.id(0))
        const local = map.map_info.players[0],
            other = map.map_info.players[1]
        assert.deepEqual(local.group.heros, [hero0.guid, extra.guid])
        assert.deepEqual(local.group.pets, ['0', pet0.guid])
        assert.deepEqual(local.group.pet_cfgid, [0, pet0.config_id])
        assert.deepEqual(other.group.heros, [hero1.guid])
        assert.deepEqual(other.group.pets, [pet1.guid])
        assert.deepEqual(other.group.pet_cfgid, [pet1.config_id])
        assert.deepEqual(other.move[0].pos, peerState.world.pos)

        const actorCache = new Map(),
            ownConfigIds = new Map()
        for (const packet of packets.slice(0, mapIndex).filter((packet) => packet.id === idOf('HeroAttrInfoSync')))
            for (const info of decode(packet).heros) {
                actorCache.set(info.hero_guid, info)
                // Current CheckHeroData06029d39 updates the owned config map
                // only for FO_Hero with this receiver's actual lower32 PID.
                const guid = BigInt(info.hero_guid)
                if (guid >> 56n === 1n && (guid & 0xffffffffn) === BigInt(f.id(0)))
                    ownConfigIds.set(info.hero_conf_id, info.hero_guid)
            }
        assert.equal(actorCache.get(hero1.guid)?.hero_conf_id, hero1.conf_id)
        assert.equal(actorCache.get(pet1.guid)?.hero_conf_id, pet1.config_id)
        assert.equal(actorCache.get(pet0.guid)?.hero_conf_id, pet0.config_id)
        assert.equal(ownConfigIds.get(hero0.conf_id), hero0.guid)
        const battle = packets
            .slice(mapIndex + 1)
            .filter((packet) => packet.id === idOf('ObjBattleInfoSync'))
            .flatMap((packet) => decode(packet).infos)
        assert(battle.some((info) => info.uuid === hero1.guid))
        assert(battle.some((info) => info.uuid === pet1.guid))
        assert.deepEqual(f.store.playerById.get(f.id(1)), peer)
        assert.deepEqual(f.state(1), peerState)
        assert.equal(f.store.readCacheToken(f.id(1)), peerToken)

        const peerPackets = f.call(1, 'EnterDungeonScene', { scene_id: peerState.world.map_id, creator_id: f.id(0) }),
            peerMap = peerPackets
                .filter((packet) => packet.id === idOf('WorldMapSync'))
                .map(decode)
                .find((value) => value.cmd === 256)
        assert.equal(peerMap.creator_id, f.id(0))
        assert.equal(peerMap.player_id, f.id(1))
        assert.deepEqual(
            peerMap.map_info.players.map((player) => player.player_id),
            [f.id(0), f.id(1)],
        )
        assert.equal(teams.backend, null)
    } finally {
        f.close()
    }
})
