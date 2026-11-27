import test from 'node:test'
import assert from 'node:assert/strict'
import { sharedSceneFixture } from './team-v2-shared-scene-fixture.js'
import { protocol, tables } from './team-v2-target-change-fixture.js'
import { currentMapFormation } from '../src/current-map-member.js'
import { expandBattleReport } from '../src/combat-state.js'
import { ErrorCode } from '../src/error-codes.js'
import { playerIsInBattle } from '../src/player-battle-state.js'

test('current remote damage effect reaches only the target controller and shared HP advances real waves without resurrecting private caches', () => {
    const f = sharedSceneFixture(),
        id = (name) => protocol.byName.get(name).id,
        decode = (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        run = () => f.runs.read(f.room().run_id),
        hero = (who) => currentMapFormation(f.state(who)).control.guid,
        first = f.compiled.stages[1],
        second = f.compiled.stages[2],
        enemy = ((3n << 56n) | BigInt(first.row.id)).toString(),
        unique = '9007199254740993',
        element = tables.get('skillsub_ele_value').find((row) => row.elementId > 0),
        stamp = String(f.now() * 1000 + 20),
        relay = {
            base_time: stamp,
            uint64_dic: [hero(1), enemy, unique, String(element.elementId)],
            battle_info: [
                {
                    element_info: {
                        op: 10,
                        tar_id: '2',
                        uniqueId: '3',
                        verify_info: { battle_index: '123', source_type: 2, source_id: '-7', op_time: '1' },
                        buff: {
                            cfg_id: 4,
                            attacker_id: '1',
                            executor_id: '2',
                            source_id: '1',
                            creator_id: '1',
                            layer: 1,
                        },
                    },
                },
            ],
        }
    const report = (who, source, target, delta, index) =>
        f.call(who, 'BattleInfoReduce', {
            base_time: stamp,
            uint64_dic: [source, target, unique],
            battle_info: [
                {
                    hurt_info: {
                        from_id: '1',
                        tar_id: '2',
                        hp_change: delta,
                        dmg_inc_id: index,
                        element_uniqueId: '3',
                    },
                },
            ],
        })
    try {
        for (const who of [0, 1]) f.call(who, 'MultiCampaignPlayerLoadFinish')
        assert.throws(
            () => report(0, hero(1), enemy, -7, 1),
            (error) => error.code === ErrorCode.TeamWaitStateSync,
            'Proxy reports alone must not admit HP before the challenge marker grants control',
        )
        f.call(1, 'WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: f.compiled.stages[0].row.id,
                        complete: true,
                        state_data: { step: 1, complete: true },
                    },
                },
            ],
        })
        const initial = structuredClone(run()),
            hp = initial.encounter.entities[enemy].hp,
            peerBefore = structuredClone(f.state(0)),
            privateNpcs = [0, 1].map((who) => structuredClone(f.state(who).combat.entities)),
            packets = f.call(1, 'BattleInfoReduce', relay),
            forwarded = packets.filter((packet) => packet.id === id('SCProtoBattleInfoReduceNtf'))
        assert.equal(forwarded.length, 1)
        assert.equal(forwarded[0].recipient, f.id(0))
        const forwardedElement = expandBattleReport(decode(forwarded[0]))[0].element_info
        assert.equal(forwardedElement.op, 10)
        assert.equal(forwardedElement.tar_id, enemy)
        assert.equal(forwardedElement.buff.attacker_id, hero(1))
        assert.equal(forwardedElement.verify_info.source_id, '-7', 'Signed provenance is not an actor GUID')
        assert.equal(run().encounter.entities[enemy].hp, hp, 'A remote effect command is not yet an HP result')
        assert.deepEqual(f.state(0), peerBefore, 'Relaying must not borrow the controller profile as a mutable draft')
        const anotherTarget = (BigInt(enemy) | (1n << 32n)).toString(),
            anotherRelay = structuredClone(relay)
        anotherRelay.uint64_dic[1] = anotherTarget
        assert(
            f
                .call(1, 'BattleInfoReduce', anotherRelay)
                .some((packet) => packet.id === id('SCProtoBattleInfoReduceNtf') && packet.recipient === f.id(0)),
            'A remote-effect identity must include its executor,not suppress a distinct target',
        )
        const afterRelay = structuredClone(run()),
            repeatedRelay = f.call(1, 'BattleInfoReduce', relay)
        assert(
            !repeatedRelay.some((packet) => packet.id === id('SCProtoBattleInfoReduceNtf')),
            'A retried command must not trigger another local numerical execution',
        )
        assert.deepEqual(run(), afterRelay)
        assert.throws(
            () => report(1, hero(1), enemy, -7, 1),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(run(), afterRelay, 'The attacker is not necessarily the authorized HP reporter')
        const accepted = report(0, hero(1), enemy, -7, 1)
        assert.equal(run().encounter.entities[enemy].hp, hp - 7)
        assert.equal(run().encounter.damage_by_player[f.id(1)], '7')
        for (const who of [0, 1]) {
            const hpPackets = accepted
                .filter(
                    (packet) =>
                        packet.id === id('CSProtoObjBattleInfoSync') && (packet.recipient ?? f.id(0)) === f.id(who),
                )
                .flatMap((packet) => decode(packet).infos)
            assert(hpPackets.some((info) => info.uuid === enemy && info.hp === hp - 7))
            assert.deepEqual(
                f.state(who).combat.entities,
                privateNpcs[who],
                'Private NPC caches must never become the shared writer',
            )
        }
        const retry = report(0, hero(1), enemy, -7, 1)
        assert.equal(run().encounter.entities[enemy].hp, hp - 7)
        assert(retry.some((packet) => packet.id === id('SCProtoBattleInfoReduceNtf')))
        assert(
            !retry.some((packet) => packet.id === id('SCProtoBattleInfoReduceNtf') && packet.recipient === f.id(1)),
            'A retry needs its own ACK,but must not replay damage presentation to peers',
        )
        const beforeFailure = structuredClone(run()),
            callerBefore = structuredClone(f.state(0)),
            originalPacket = f.game.packet
        let observedSharedWrite = false
        try {
            f.game.packet = function (name, ...args) {
                if (name === 'CSProtoObjBattleInfoSync' && run().encounter.entities[enemy].hp === hp - 12) {
                    observedSharedWrite = true
                    throw Error('injected-shared-output-failure')
                }
                return originalPacket.call(this, name, ...args)
            }
            assert.throws(() => report(0, hero(1), enemy, -5, 2), /injected-shared-output-failure/)
        } finally {
            f.game.packet = originalPacket
        }
        assert(observedSharedWrite, 'The fault must occur after the canonical SQL change inside its transaction')
        assert.deepEqual(run(), beforeFailure, 'Output failure after canonical SQL write must roll back the shared row')
        assert.deepEqual(f.state(0), callerBefore, 'The same failure must roll back private counters and energy')
        report(0, hero(1), enemy, -5, 2)
        assert.equal(run().encounter.entities[enemy].hp, hp - 12)
        const batch = f.call(0, 'BattleInfoReduce', {
                base_time: stamp,
                uint64_dic: [hero(1), enemy],
                battle_info: [
                    { hurt_info: { from_id: '1', tar_id: '2', hp_change: -2, dmg_inc_id: 3 } },
                    { hurt_info: { from_id: '1', tar_id: '2', hp_change: -2, dmg_inc_id: 3 } },
                    { hurt_info: { from_id: '1', tar_id: '2', hp_change: -3, dmg_inc_id: 4 } },
                ],
            }),
            acknowledged = (who) =>
                batch
                    .filter(
                        (packet) =>
                            packet.id === id('SCProtoBattleInfoReduceNtf') &&
                            (packet.recipient ?? f.id(0)) === f.id(who),
                    )
                    .flatMap((packet) => decode(packet).battle_info)
        assert.deepEqual(
            acknowledged(0).map((row) => row.hurt_info.cur_hp),
            [hp - 14, hp - 14, hp - 17],
            'Owner ACK must preserve per-event HP,including the duplicate row',
        )
        assert.deepEqual(
            acknowledged(1).map((row) => row.hurt_info.cur_hp),
            [hp - 14, hp - 17],
            'A duplicate later in the same packet must not suppress the first real hit for peers',
        )
        const otherBefore = structuredClone(f.state(0)),
            targetHero = hero(1),
            heroHp = f.state(1).player.heros_info.battle_infos.find((value) => value.hero_id === targetHero).hp
        report(1, enemy, targetHero, -3, 1)
        assert.equal(
            f.state(1).player.heros_info.battle_infos.find((value) => value.hero_id === targetHero).hp,
            heroHp - 3,
        )
        assert.deepEqual(f.state(0), otherBefore, 'Personal HP remains with its actual owner')
        for (const who of [0, 1]) {
            f.call(who, 'PlayerHatredIncSync', {
                inc: true,
                info: { id: String(f.id(who)), target_obj_ids: [enemy], player_obj_ids: [] },
            })
            assert(
                playerIsInBattle(f.state(who)),
                'Canonical active wave must not be pruned by the private initial-stage cache',
            )
        }
        const killWave = (stage, startIndex) => {
            const ids = Object.keys(run().encounter.entities).filter(
                (uuid) => Number(BigInt(uuid) & 0xffffffffn) === stage.row.id,
            )
            return f.call(0, 'BattleInfoReduce', {
                base_time: stamp,
                uint64_dic: [hero(1), ...ids],
                battle_info: ids.map((uuid, index) => ({
                    hurt_info: {
                        from_id: '1',
                        tar_id: String(index + 2),
                        hp_change: -0x7fffffff,
                        dmg_inc_id: startIndex + index,
                    },
                })),
            })
        }
        const firstClear = killWave(first, 5),
            afterFirst = run()
        assert.equal(afterFirst.encounter.stage_index, second.index)
        assert.equal(afterFirst.encounter.control.object_id, second.row.id)
        assert.equal(afterFirst.encounter.control.epoch, 2)
        for (const who of [0, 1])
            assert(!playerIsInBattle(f.state(who)), 'Only the completed wave relations must be cleared for each owner')
        f.call(1, 'PlayerHatredIncSync', {
            inc: true,
            info: { id: String(f.id(1)), target_obj_ids: [enemy], player_obj_ids: [] },
        })
        assert(
            !playerIsInBattle(f.state(1)),
            'Late aggro for a completed canonical wave must not put its player back in combat',
        )
        assert(
            firstClear.some(
                (packet) => packet.id === id('SCProtoControlChangeByDelNtf') && packet.recipient === f.id(0),
            ),
        )
        assert(
            firstClear.some(
                (packet) => packet.id === id('SCProtoControlChangeByAddNtf') && packet.recipient === f.id(0),
            ),
        )
        report(0, hero(1), enemy, 9999, 20)
        assert.equal(run().encounter.entities[enemy].hp, 0, 'Late healing reports must not resurrect a completed wave')
        const scene = f.call(1, 'EnterDungeonScene', { scene_id: f.compiled.route.scene.id }),
            world = scene
                .filter((packet) => packet.id === id('CSProtoWorldMapSync'))
                .map(decode)
                .find((value) => value.cmd === 256)
        assert.deepEqual(
            world.map_info.objs.find((object) => object.obj_id === first.row.id).expand_data.battle_group.world_indexes,
            [],
        )
        assert(world.map_info.objs.find((object) => object.obj_id === second.row.id).active)
        killWave(second, 30)
        const finished = run()
        assert.equal(finished.phase, 'complete')
        assert.equal(finished.encounter.control, null)
        assert(Object.values(finished.encounter.entities).every((value) => value.hp === 0))
        for (const who of [0, 1]) {
            assert.equal(f.state(who).entrust.run.battle_complete, true)
            assert.equal(f.state(who).entrust.run.shared_victory.id, finished.id)
            assert.deepEqual(f.state(who).combat.entities, privateNpcs[who])
        }
        assert.equal(f.teams.backend, null)
    } finally {
        f.close()
    }
})
