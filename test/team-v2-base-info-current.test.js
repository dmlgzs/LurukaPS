import test from 'node:test'
import assert from 'node:assert/strict'
import { targetFixture, tables, protocol } from './team-v2-target-change-fixture.js'
import { heroModules, heroBattleLimits } from '../src/battle.js'
import { ErrorCode } from '../src/error-codes.js'
import { gmHeroRewards } from '../src/gm-roster-catalogue.js'
import { entrustMultiBaseSnapshot } from '../src/entrust.js'

test('shared scene refresh and login-packet construction rebuild every member and preserve current control/vitals without peer writes', () => {
    const f = targetFixture({ count: 2 }),
        teams = f.game.teamV2,
        runs = teams.runs,
        entry = protocol.byName.get('CSProtoMultiCampaignBaseInfoSync')
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
    const base = (packets) => {
        const packet = packets.find((value) => value.id === entry.id)
        assert(packet)
        return protocol.decode(entry.rsp, packet.payload)
    }
    const ui = new Map()
    // Current060015c7 clears the map on each base-info packet.060015c4 also
    // changes controlHero from each attribute row,not merely its HP/SP.
    const consume = (data) => {
        ui.clear()
        for (const member of data.player_list)
            ui.set(member.pid, {
                control: member.data.group.control_hero,
                hp: 0,
                sp: 0,
                maxHp: 0,
                maxSp: 0,
                heroes: member.data.group.hero_list.map((hero) => hero.hero_id),
            })
        for (const attr of data.player_attr_list) {
            const member = ui.get(attr.player_id)
            assert(member && member.heroes.includes(attr.hero_id))
            Object.assign(member, {
                control: attr.hero_id,
                hp: attr.hp,
                sp: attr.sp,
                maxHp: attr.max_hp,
                maxSp: attr.max_sp,
            })
        }
    }
    try {
        const gift = gmHeroRewards(tables, f.state(0))[0],
            b64 = (value) => Buffer.from(String(value)).toString('base64')
        assert(gift)
        // One real GM companion grant prepares a two-hero formation whose
        // control is deliberately the first slot,not the last attribute row.
        f.call(0, 'GMCommand', { command: b64('give'), args: [gift.itemtype, gift.itemid, 1].map(b64) })
        const owner = f.state(0),
            manager = owner.player.group_mgrs.find((value) => value.type === 1),
            group = manager.groups.find((value) => value.id === manager.cur_group),
            extra = owner.player.heros_info.heros.find((value) => value.conf_id === gift.itemid)
        f.call(0, 'QuickChangeGroupInfo', {
            type: 1,
            id: group.id,
            infos: [
                { hero_guid: group.control, pet_guid: '0' },
                { hero_guid: extra.guid, pet_guid: '0' },
            ],
        })
        f.create()
        // Trusted internal checkpoints isolate this dependency. Public Ready/
        // Start and loading/controller/shared battle are not produced here.
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 3, ready: [f.id(0), f.id(1)] }, 0))
        transaction((c) => runs.admit(c, f.room()))
        const dungeon = tables.find('dungeon_material', 10101)
        const solo = base(f.call(0, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 }))
        assert.equal(solo.player_list.length, 1)
        assert.equal(solo.player_attr_list.length, 1)
        assert.equal(solo.player_list[0].data.group.hero_list.length, 2)
        assert.equal(solo.player_attr_list[0].hero_id, solo.player_list[0].data.group.control_hero)
        f.call(1, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })
        // Accepted stored vitals checkpoint,not a damage-report test or a win.
        for (const who of [0, 1])
            f.store.transact(f.id(who), 0, (state) => {
                const manager = state.player.group_mgrs.find((value) => value.type === 1),
                    group = manager.groups.find((value) => value.id === manager.cur_group),
                    row = state.player.heros_info.battle_infos.find((value) => value.hero_id === group.control)
                row.hp = Math.max(1, row.hp - 11 - who)
                row.sp = Math.max(0, row.sp - 7 - who)
            })
        transaction((c) => runs.bindScenes(c))
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 4 }, 0))
        const expected = [0, 1].map((who) => {
            const state = f.state(who),
                manager = state.player.group_mgrs.find((value) => value.type === 1),
                group = manager.groups.find((value) => value.id === manager.cur_group),
                hero = state.player.heros_info.heros.find((value) => value.guid === group.control),
                saved = state.player.heros_info.battle_infos.find((value) => value.hero_id === hero.guid),
                limits = heroBattleLimits(heroModules(tables, state, hero))
            return {
                player_id: f.id(who),
                hero_id: hero.conf_id,
                hp: saved.hp,
                sp: saved.sp,
                max_hp: limits.hp,
                max_sp: limits.sp,
                alive_state: saved.alive_state,
            }
        })
        const peer = f.store.playerById.get(f.id(1)),
            peerState = structuredClone(f.state(1)),
            token = f.store.readCacheToken(f.id(1)),
            refreshed = base(f.call(0, 'EnterDungeonScene', { scene_id: f.state(0).world.map_id, creator_id: f.id(0) }))
        assert.deepEqual(
            refreshed.player_list.map((member) => member.pid),
            [f.id(0), f.id(1)],
        )
        assert.deepEqual(refreshed.player_attr_list, expected)
        consume(refreshed)
        assert.equal(ui.get(f.id(1)).hp, expected[1].hp)
        assert.equal(ui.get(f.id(1)).control, expected[1].hero_id)
        assert.deepEqual(f.store.playerById.get(f.id(1)), peer)
        assert.deepEqual(f.state(1), peerState)
        assert.equal(f.store.readCacheToken(f.id(1)), token)

        // Exercise the actual login-packet producer on this still-current
        // connection,not a new token/rejoin or a complete client-login test.
        const login = transaction((c) =>
            f.game.loginPackets(
                c.state,
                f.sessions[0],
                { reconnect: true },
                { seq: 9001, pushSeq: 0 },
                protocol.byName.get('CSProtoEnterGame').id,
            ),
        )
        const restored = base(login)
        consume(restored)
        assert.equal(ui.size, 2)
        assert.deepEqual(restored.player_attr_list, expected)
        assert.deepEqual(f.store.playerById.get(f.id(1)), peer)
        assert.throws(
            () =>
                entrustMultiBaseSnapshot(tables, f.state(0), f.id(0), {
                    sharedRuns: runs,
                    combatSessionId: f.sessions[0].token + ':stale',
                }),
            (error) => error.code === ErrorCode.TeamTargetChanged,
        )
        assert.equal(teams.backend, null)
    } finally {
        f.close()
    }
})
