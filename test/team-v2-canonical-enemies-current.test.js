import test from 'node:test'
import assert from 'node:assert/strict'
import { targetFixture, tables, protocol } from './team-v2-target-change-fixture.js'
import { compileSharedTeamTarget } from '../src/team-v2-run-target.js'
import { enemyBaseHpValue, enemyDefinition } from '../src/enemy-state.js'
import { dungeonEnemyScales } from '../src/dungeon-enemy-scale.js'
import { ErrorCode } from '../src/error-codes.js'

test('current two-player table scaling and one encounter source survive per-member proxy reports without copying private combat progress', () => {
    const f = targetFixture({ count: 2 }),
        teams = f.game.teamV2,
        runs = teams.runs,
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
    const query = (who) => ({
        id: f.id(who),
        state: f.state(who),
        tables,
        now: f.now(),
        combatSessionId: f.sessions[who].token,
    })
    let lastScenePackets
    const scene = (who) =>
        (lastScenePackets = f.call(who, 'EnterDungeonScene', { scene_id: f.state(who).world.map_id }))
            .filter((packet) => packet.id === protocol.byName.get('CSProtoWorldMapSync').id)
            .map(decode)
            .find((value) => value.cmd === 256)
    try {
        f.create()
        const compiled = compileSharedTeamTarget(tables, f.room()),
            firstObject = compiled.objects[0].objectId,
            uid = ((3n << 56n) | BigInt(firstObject)).toString(),
            index = tables.find('dungeon_multi_index', compiled.route.dungeon.multiIndex)
        assert.equal(index.id, 3)
        assert(index.doubleNum.includes('5#22400'))
        // Explicit PRE_START/PLAY checkpoints isolate this dependency;not a
        // produced public Ready/Start or a completed shared battle.
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 3, ready: [f.id(0), f.id(1)] }, 0))
        transaction((c) => runs.admit(c, f.room()))
        f.call(0, 'MultiCampaignCreate', { dungeon_id: compiled.definition.dungeonId, scene_type: 12 })
        f.call(1, 'MultiCampaignCreate', { dungeon_id: compiled.definition.dungeonId, scene_type: 12 })
        const base = f.state(0).combat.entities[uid],
            raw = enemyBaseHpValue(tables, base),
            expectedHp = Math.floor(Math.fround(raw * Math.fround(22400 / 10000))),
            privatePeer = structuredClone(f.state(1).combat.entities)
        assert(expectedHp > base.max_hp)
        // One synthetic source-composition probe,not a mode matrix or a new
        // official table claim. Current IL retains nonparticipant attributes.
        const proxy = Object.create(tables),
            dungeonRow = { ...compiled.route.dungeon, difficultIndex: `${firstObject}#5#7500#3#9000` }
        proxy.find = (name, id) =>
            name === 'dungeon' && Number(id) === dungeonRow.id ? dungeonRow : tables.find(name, id)
        const combined = dungeonEnemyScales(
            proxy,
            dungeonRow.id,
            compiled.route.scene.id,
            tables.find(`worldmap_${compiled.route.scene.id}`, firstObject).expandId,
            2,
        )
        assert.equal(combined.get(5), 16800)
        assert.equal(combined.get(3), 9000)
        assert.equal(
            enemyDefinition(proxy, f.state(0), uid).max_hp,
            Math.floor(Math.fround(raw * 0.75)),
            'An ordinary private run must apply the same configured base scale,without a multiplayer multiplier',
        )
        const beforeBind = structuredClone(f.state(0))
        assert.throws(
            () =>
                transaction((c) => {
                    c.state.combat.entities[uid].hp--
                    runs.bindScenes(c)
                }),
            (error) => error.code === ErrorCode.TeamInBattle,
        )
        assert.deepEqual(f.state(0), beforeBind, 'A used entry must be rejected,not reset into a fresh shared battle')
        transaction((c) => runs.bindScenes(c))
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 4 }, 0))
        const first = scene(0),
            firstHp = first.map_info.objs.find((object) => object.obj_id === firstObject).expand_data.battle_group
                .monsters[0].hp
        assert.equal(firstHp, expectedHp, 'Shared NPC snapshot must use current participant coefficients')
        const currentInfo = lastScenePackets
            .filter((packet) => packet.id === protocol.byName.get('CSProtoCurMultiCampaignInfoSync').id)
            .map(decode)
        assert(
            currentInfo.length > 0 && currentInfo.every((info) => info.dungeon_player_num === 2),
            'PlayingData must receive the participant count used by native attribute scaling',
        )
        const hpFrames = lastScenePackets
            .filter((packet) => packet.id === protocol.byName.get('CSProtoObjBattleInfoSync').id)
            .flatMap((packet) => decode(packet).infos)
            .filter((info) => info.uuid === uid)
        assert(hpFrames.length > 0)
        assert(
            hpFrames.every((info) => info.hp === expectedHp),
            'A private post-map HP replay must not overwrite canonical HP',
        )
        const other = scene(1)
        assert.equal(
            other.map_info.objs.find((object) => object.obj_id === firstObject).expand_data.battle_group.monsters[0].hp,
            expectedHp,
        )
        assert.deepEqual(f.state(1).combat.entities, privatePeer, 'Snapshot must not overwrite a private combat cache')
        assert.equal(runs.proxyReportStatus(query(0)).all_current, false)
        f.call(0, 'MultiCampaignPlayerLoadFinish')
        assert.deepEqual(runs.proxyReportStatus(query(0)).pending, [f.id(1)])
        const row = runs.read(f.room().run_id)
        f.call(0, 'MultiCampaignPlayerLoadFinish')
        assert.deepEqual(runs.read(f.room().run_id), row, 'Duplicate report must not fabricate a second participant')
        const peerReport = f.call(1, 'MultiCampaignPlayerLoadFinish')
        assert.equal(runs.proxyReportStatus(query(0)).all_current, true)
        assert.equal(runs.proxyReportStatus(query(1)).all_current, true)
        const token = f.sessions[1].token
        f.sessions[1].token = token + ':replaced'
        assert.equal(
            runs.proxyReportStatus(query(0)).all_current,
            false,
            'A stale connection receipt cannot satisfy the barrier',
        )
        f.sessions[1].token = token
        assert(!peerReport.some((packet) => packet.id === protocol.byName.get('SCProtoControlChangeByAddNtf').id))
        const canonical = runs.read(f.room().run_id).encounter
        assert.equal(canonical.entities[uid].hp, expectedHp)
        assert.equal(canonical.stage_index, compiled.stages[0].index)
        assert.equal(canonical.entities[uid].alive_state, 0)
        assert.equal(f.state(0).entrust.run.battle_complete, undefined)
        assert.equal(f.state(1).entrust.run.battle_complete, undefined)
        assert.throws(
            () => f.call(0, 'BattleInfoReduce', { base_time: String(f.now() * 1000), battle_info: [], uint64_dic: [] }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.equal(teams.backend, null)
    } finally {
        f.close()
    }
})
