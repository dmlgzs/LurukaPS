import test from 'node:test'
import assert from 'node:assert/strict'
import { targetFixture, tables, protocol } from './team-v2-target-change-fixture.js'
import { gmHeroRewards } from '../src/gm-roster-catalogue.js'
import { ErrorCode } from '../src/error-codes.js'

test('actual shared load callback supplies current player appearance and stable agents through retry and control change without private NPC grants', () => {
    const f = targetFixture({ count: 2 }),
        teams = f.game.teamV2,
        runs = teams.runs,
        b64 = (value) => Buffer.from(String(value)).toString('base64'),
        idOf = (name) => protocol.byName.get(name).id,
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
    const appears = (packets) =>
        packets
            .filter((packet) => packet.id === idOf('SCProtoObjAppearNtf'))
            .map(decode)
            .filter((value) => value.player)
    const records = new Map(),
        units = new Map()
    // CurrentRefreshRecord060287f4 creates a record once; current non-city
    // PlayerAppear06029e8f/TryCreateOtherPlayerUnit06029e95 keys units by PID.
    const consume = (appearance) => {
        assert.equal(appearance.agent_type, 1)
        const info = appearance.player,
            pid = info.player_id,
            group = info.player_info.group
        assert.notEqual(pid, f.id(0))
        assert.equal(info.player_info.player_id, pid)
        assert.equal(info.hero.guid, group.control)
        assert.equal(info.hero_attr.hero_guid, group.control)
        assert.equal(info.hero_battle_info.uuid, group.control)
        if (records.has(appearance.agent_uid)) assert.equal(records.get(appearance.agent_uid), pid)
        else records.set(appearance.agent_uid, pid)
        if (!units.has(pid)) units.set(pid, { created: 1 })
        const slot = group.heros.indexOf(group.control),
            petGuid = group.pets[slot]
        if (petGuid !== '0') {
            assert.equal(info.pet_full_attr.guid, petGuid)
            assert.equal(info.pet_base_info.guid, petGuid)
            assert.equal(info.pet_full_attr.conf_id, group.pet_cfgid[slot])
            assert.equal(info.pet_battle_info.uuid, petGuid)
            assert.equal(info.pet_full_attr.type, info.pet_base_info.type)
        }
        units.get(pid).current = info.hero.guid
    }
    try {
        const gift = gmHeroRewards(tables, f.state(1))[0]
        f.call(1, 'GMCommand', { command: b64('give'), args: [1, gift.itemid, 1].map(b64) })
        f.call(1, 'GMCommand', { command: b64('give'), args: [5, 500001, 1].map(b64) })
        const main = f.state(1).player.heros_info.heros[0],
            extra = f.state(1).player.heros_info.heros.find((hero) => hero.conf_id === gift.itemid),
            pet = f.state(1).pets.find((value) => value.config_id === 500001),
            manager = f.state(1).player.group_mgrs.find((value) => value.type === 1)
        f.call(1, 'QuickChangeGroupInfo', {
            type: 1,
            id: manager.cur_group,
            infos: [
                { hero_guid: main.guid, pet_guid: pet.guid },
                { hero_guid: extra.guid, pet_guid: '0' },
            ],
        })
        f.create()
        // Explicit internal phase checkpoints only. Public Ready/Start and
        // canonical shared combat remain unimplemented in this focused test.
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 3, ready: [f.id(0), f.id(1)] }, 0))
        transaction((c) => runs.admit(c, f.room()))
        const dungeon = tables.find('dungeon_material', 10101)
        f.call(0, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })
        f.call(1, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })
        transaction((c) => runs.bindScenes(c))
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 4 }, 0))
        const scene = f
            .call(0, 'EnterDungeonScene', { scene_id: f.state(0).world.map_id })
            .filter((packet) => packet.id === idOf('CSProtoWorldMapSync'))
            .map(decode)
            .find((value) => value.cmd === 256)
        assert.equal(scene.area_id ?? 0, 0, 'Currentcity switch is top-level areaId>0,not map_info.area_id')
        const peer = f.store.playerById.get(f.id(1)),
            peerState = structuredClone(f.state(1)),
            stage = f.state(0).entrust.run.stage_index,
            first = f.call(0, 'MultiCampaignPlayerLoadFinish'),
            firstAppear = appears(first)
        assert.equal(firstAppear.length, 1, 'A real player SCObjAppear payload must initialize the peer')
        consume(firstAppear[0])
        assert.equal(firstAppear[0].player.hero.guid, main.guid)
        assert.equal(firstAppear[0].player.pet_full_attr.guid, pet.guid)
        assert(firstAppear[0].player.pet_full_attr.modules.length > 0)
        assert.equal(f.state(0).entrust.run.loading_complete_at, f.now())
        assert.equal(f.state(0).entrust.run.stage_index, stage)
        assert(!first.some((packet) => packet.id === idOf('SCProtoControlChangeByAddNtf')))
        assert(!first.some((packet) => packet.id === idOf('CSProtoMultiCampaignPlayerLoadFinish')))
        assert.deepEqual(f.store.playerById.get(f.id(1)), peer)
        assert.deepEqual(f.state(1), peerState)
        const savedCaller = f.store.playerById.get(f.id(0)),
            runBeforeRetry = runs.read(f.room().run_id),
            retry = appears(f.call(0, 'MultiCampaignPlayerLoadFinish'))
        assert.equal(retry[0].agent_uid, firstAppear[0].agent_uid)
        consume(retry[0])
        assert.equal(units.size, 1)
        assert.deepEqual(
            f.store.playerById.get(f.id(0)),
            savedCaller,
            'Unchanged loading ACK must not rewrite the profile',
        )
        assert.deepEqual(runs.read(f.room().run_id), runBeforeRetry)

        // Actual current control request changes the appearance snapshot,not
        // its stable per-run agent. This is not realtimeSwitchBC/Unity proof.
        f.call(1, 'SwitchWorldGroupControl', { type: 1, control: extra.guid })
        const changed = appears(f.call(0, 'MultiCampaignPlayerLoadFinish'))[0]
        assert.equal(changed.agent_uid, firstAppear[0].agent_uid)
        assert.equal(changed.player.hero.guid, extra.guid)
        assert.equal(changed.player.pet_full_attr, undefined)
        consume(changed)
        assert.equal(units.size, 1)
        const other = appears(f.call(1, 'MultiCampaignPlayerLoadFinish'))
        assert.equal(other.length, 1)
        assert.equal(other[0].player.player_id, f.id(0))
        assert.notEqual(other[0].agent_uid, firstAppear[0].agent_uid)
        transaction((c) => runs.close(c))
        assert.throws(
            () => f.call(0, 'MultiCampaignPlayerLoadFinish'),
            (error) => error.code === ErrorCode.TeamWaitStateSync,
        )
        assert.equal(teams.backend, null)
    } finally {
        f.close()
    }
})
