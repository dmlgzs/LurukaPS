import test from 'node:test'
import assert from 'node:assert/strict'
import { sharedSceneFixture } from './team-v2-shared-scene-fixture.js'
import { protocol, tables } from './team-v2-target-change-fixture.js'
import { currentMapFormation } from '../src/current-map-member.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { entrustChallengeGoals } from '../src/entrust-challenge-goals.js'

test('current shared material victory commits each account once and keeps paid chest costs/rewards personal', () => {
    const f = sharedSceneFixture(),
        runs = f.runs,
        current = () => runs.read(f.room().run_id),
        configId = f.compiled.definition.configId,
        stages = f.compiled.stages,
        chest = getEntrustCatalog(tables).chest(configId, 'material'),
        id = (name) => protocol.byName.get(name).id,
        decode = (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        stamina = (who) => BigInt(f.state(who).player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val),
        assets = (who) => {
            const player = f.state(who).player
            return structuredClone({
                attrs: player.attr_infos,
                bag: player.sbag_infos,
                ornaments: player.soulessence_infos,
                gold: player.basic_info.gold,
                diamond: player.basic_info.diamond,
                lv: player.basic_info.lv,
                exp: player.basic_info.exp,
            })
        },
        kill = (stage, firstIndex) => {
            const ids = Object.keys(current().encounter.entities).filter(
                (guid) => Number(BigInt(guid) & 0xffffffffn) === stage.row.id,
            )
            return f.call(0, 'BattleInfoReduce', {
                base_time: String(f.now() * 1000 + 1),
                uint64_dic: [currentMapFormation(f.state(0)).control.guid, ...ids],
                battle_info: ids.map((guid, index) => ({
                    hurt_info: {
                        from_id: '1',
                        tar_id: String(index + 2),
                        hp_change: -0x7fffffff,
                        dmg_inc_id: firstIndex + index,
                    },
                })),
            })
        },
        claim = (who) => f.call(who, 'StaminaBoxGet', { box_id: chest.id, times: 1 })
    try {
        assert.deepEqual(
            entrustChallengeGoals(
                tables,
                { kind: 'material', entrust_id: configId },
                { ...f.compiled.route.scene, challengeGroup: 999999 },
                f.compiled.route.dungeon,
            ).map((goal) => goal.challengeCondition),
            f.compiled.route.dungeon.challenge.split('|'),
            'Current dungeon list must not be replaced by a scene alias',
        )
        for (const who of [0, 1]) f.call(who, 'MultiCampaignPlayerLoadFinish')
        f.call(0, 'WorldObjInteract', {
            objs: [{ obj: { obj_id: stages[0].row.id, complete: true, state_data: { step: 1, complete: true } } }],
        })
        // Independent balance/history qualification: many past deaths followed
        // by revival do not change the current alive formation. No HP,kill or
        // victory facts are injected; both waves below use real dispatch.
        f.store.transact(f.id(1), 0, (state) => {
            state.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val = '0'
            state.entrust.run.hero_deaths = 9
        })
        const beforeAssets = [assets(0), assets(1)],
            privateNpc = [0, 1].map((who) => structuredClone(f.state(who).combat.entities))
        assert.throws(
            () => claim(0),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => f.call(0, 'EndDungeonScene', { result: 3 }),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        f.advance(20)
        kill(stages[1], 1)
        const beforeFinal = structuredClone(current()),
            playersBefore = [structuredClone(f.state(0)), structuredClone(f.state(1))]
        f.store.db.exec(`CREATE TRIGGER fail_shared_peer_victory BEFORE UPDATE ON players
            WHEN NEW.account_id=${f.id(1)} BEGIN SELECT RAISE(ABORT,'shared peer victory SQL failure'); END`)
        try {
            assert.throws(() => kill(stages[2], 20), /shared peer victory SQL failure/)
        } finally {
            f.store.db.exec('DROP TRIGGER fail_shared_peer_victory')
        }
        assert.deepEqual(current(), beforeFinal)
        for (const who of [0, 1])
            assert.deepEqual(
                f.state(who),
                playersBefore[who],
                'Peer SQL failure must roll back all participant victories',
            )
        const won = kill(stages[2], 20),
            run = current()
        assert.equal(run.phase, 'complete')
        for (const who of [0, 1]) {
            const personal = f.state(who).entrust.run,
                sent = won.filter((packet) => (packet.recipient ?? f.id(0)) === f.id(who)),
                materialAt = sent.findIndex((packet) => packet.id === id('SCProtoDungeonMaterialInfoSync')),
                winAt = sent.findIndex(
                    (packet) => packet.id === id('CSProtoCurMultiCampaignInfoSync') && decode(packet).status === 4,
                )
            assert.equal(personal.battle_complete, true)
            assert.equal(personal.shared_victory.id, run.id)
            assert.equal(personal.squad_disabled_count, 0)
            assert.equal(
                personal.star_mask,
                7,
                'Current60010#0#1 uses settlement-disabled count0,not death history or the trailing1',
            )
            assert.equal(f.state(who).materialDungeonRecords[configId].success_count, 1)
            assert(
                materialAt >= 0 && winAt > materialAt,
                'Refresh personal material record before the WIN callback consumes it',
            )
            assert(sent.some((packet) => packet.id === id('SCProtoObjAppearNtf') && decode(packet).agent_type === 9))
            assert.deepEqual(
                assets(who),
                beforeAssets[who],
                'Victory itself must not charge or pay the stamina-funded chest',
            )
            assert.deepEqual(f.state(who).combat.entities, privateNpc[who])
            f.call(who, 'EndDungeonScene', { result: 3 })
            assert.equal(f.state(who).materialDungeonRecords[configId].success_count, 1)
        }
        const beforePay = stamina(0),
            peerBeforePay = structuredClone(f.state(1)),
            paid = claim(0),
            reward = decode(paid.find((packet) => packet.id === id('CSProtoStaminaBoxGet'))).reward.rewards
        assert(reward.length > 0)
        assert.equal(stamina(0), beforePay - 30n)
        assert.equal(f.state(0).entrust.run.chest_claimed, true)
        assert.deepEqual(f.state(1), peerBeforePay)
        const paidAssets = assets(0)
        claim(0)
        assert.deepEqual(assets(0), paidAssets, 'A repeat claim must not charge or reward again')
        const noFunds = structuredClone(f.state(1))
        assert.throws(
            () => claim(1),
            (error) => error.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(1), noFunds)
        assert.equal(f.state(1).materialDungeonRecords[configId].success_count, 1)
        const scene = f.call(1, 'EnterDungeonScene', { scene_id: run.map_id }),
            world = scene
                .filter((packet) => packet.id === id('CSProtoWorldMapSync'))
                .map(decode)
                .find((packet) => packet.cmd === 256)
        assert(world.map_info.objs.find((object) => object.obj_id === chest.worldmapid).active)
        assert.equal(f.state(1).entrust.run.chest_claimed, undefined)
        f.store.transact(f.id(1), 0, (state) => grantRewards(tables, state, [{ itemtype: 10, itemid: 3, itemnum: 30 }]))
        claim(1)
        assert.equal(stamina(1), 0n)
        assert.equal(f.state(1).entrust.run.chest_claimed, true)
        for (const who of [0, 1]) {
            assert.equal(f.state(who).materialDungeonRecords[configId].success_count, 1)
            assert.deepEqual(f.state(who).combat.entities, privateNpc[who])
        }
        assert.equal(f.teams.backend, null)
    } finally {
        f.close()
    }
})
