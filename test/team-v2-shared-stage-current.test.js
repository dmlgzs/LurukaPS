import test from 'node:test'
import assert from 'node:assert/strict'
import { protocol } from './team-v2-target-change-fixture.js'
import { sharedSceneFixture } from './team-v2-shared-scene-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('current shared challenge marker advances once and grants only the selected NPC controller after distinct proxy reports', () => {
    const f = sharedSceneFixture(),
        decode = (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        packetId = (name) => protocol.byName.get(name).id,
        marker = f.compiled.stages[0],
        wave = f.compiled.stages[1],
        interaction = {
            objs: [
                {
                    obj: { obj_id: marker.row.id, complete: true, state_data: { step: 1, complete: true } },
                    interact_type: 0,
                },
            ],
        },
        current = () => f.runs.read(f.room().run_id)
    try {
        assert.equal(marker.type, 13)
        assert.equal(wave.type, 50)
        f.call(0, 'MultiCampaignPlayerLoadFinish')
        const waiting = structuredClone(current()),
            beforeCaller = structuredClone(f.state(1))
        assert.throws(
            () => f.call(1, 'WorldObjInteract', interaction),
            (error) => error.code === ErrorCode.TeamWaitStateSync,
        )
        assert.deepEqual(current(), waiting)
        assert.deepEqual(
            f.state(1),
            beforeCaller,
            'The marker/reward receipt must roll back when a peer has not reported',
        )
        f.call(1, 'MultiCampaignPlayerLoadFinish')
        const peerBefore = structuredClone(f.state(0)),
            accepted = f.call(1, 'WorldObjInteract', interaction),
            run = current(),
            agent = ((3n << 56n) | BigInt(wave.row.id)).toString(),
            controls = accepted.filter((packet) => packet.id === packetId('SCProtoControlChangeByAddNtf'))
        assert.equal(run.phase, 'playing')
        assert.equal(run.encounter.stage_index, wave.index)
        assert.equal(run.encounter.control.object_id, wave.row.id)
        assert.equal(run.encounter.control.player_id, f.id(0))
        assert.deepEqual(
            controls.map((packet) => [packet.recipient ?? f.id(1), decode(packet).agent_uid]),
            [[f.id(0), agent]],
        )
        for (const who of [0, 1]) {
            const destination = f.id(who),
                sent = accepted.filter((packet) => (packet.recipient ?? f.id(1)) === destination),
                appeared = sent.findIndex(
                    (packet) => packet.id === packetId('SCProtoObjAppearNtf') && decode(packet).agent_uid === agent,
                ),
                control = sent.findIndex((packet) => packet.id === packetId('SCProtoControlChangeByAddNtf')),
                refresh = sent.find(
                    (packet) => packet.id === packetId('CSProtoWorldMapSync') && decode(packet).cmd === 47,
                ),
                multi = sent.filter((packet) => packet.id === packetId('CSProtoCurMultiCampaignInfoSync')).map(decode)
            assert(appeared >= 0)
            if (who === 0) assert(control > appeared, 'Register group AOI before granting its control')
            else assert.equal(control, -1)
            const objects = decode(refresh).map_info.objs
            assert.equal(objects.find((row) => row.obj_id === marker.row.id).complete, true)
            assert.equal(objects.find((row) => row.obj_id === wave.row.id).active, true)
            assert(
                multi.length &&
                    multi.every(
                        (value) =>
                            value.status === 3 &&
                            value.dungeon_player_num === 2 &&
                            value.start_time === String(f.now() * 1000),
                    ),
            )
        }
        assert.deepEqual(f.state(0), peerBefore, 'Stage/controller authority must not edit the other player profile')
        assert.equal(
            f.state(1).entrust.run.stage_index,
            marker.index,
            'Personal stage cache must not become shared authority',
        )
        assert.equal(f.state(1).entrust.run.battle_complete, undefined)
        const after = structuredClone(current()),
            retry = f.call(1, 'WorldObjInteract', interaction)
        assert.deepEqual(current(), after)
        assert(!retry.some((packet) => packet.id === packetId('SCProtoControlChangeByAddNtf')))
        const reload = f.call(0, 'EnterDungeonScene', { scene_id: f.compiled.route.scene.id }),
            reloaded = reload.filter((packet) => packet.id === packetId('CSProtoCurMultiCampaignInfoSync')).map(decode)
        assert(
            reloaded.length &&
                reloaded.every((value) => value.status === 3 && value.start_time === String(f.now() * 1000)),
            'Later entry metadata must not revert to the still-private initial stage',
        )
        const replay = f.call(0, 'MultiCampaignPlayerLoadFinish')
        assert(
            replay.some(
                (packet) =>
                    packet.id === packetId('SCProtoControlChangeByAddNtf') && decode(packet).agent_uid === agent,
            ),
        )
        assert.deepEqual(current(), after, 'Current-connection control replay must not allocate a second grant')
        const login = f.transaction((c) =>
                f.game.loginPackets(
                    c.state,
                    f.sessions[0],
                    { reconnect: true },
                    { seq: 9001, pushSeq: 0 },
                    packetId('CSProtoEnterGame'),
                ),
            ),
            restored = login.filter((packet) => packet.id === packetId('CSProtoCurMultiCampaignInfoSync')).map(decode)
        assert(
            restored.length &&
                restored.every((value) => value.status === 3 && value.start_time === String(f.now() * 1000)),
            'Login metadata on the same admitted connection must also preserve the canonical stage',
        )
        assert.throws(
            () => f.call(1, 'WorldObjInteract', { objs: [{ obj: { obj_id: wave.row.id, complete: true } }] }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        const connection = f.sessions[0].token
        f.sessions[0].token += ':changed'
        assert.throws(
            () => f.call(1, 'MultiCampaignPlayerLoadFinish'),
            (error) => error.code === ErrorCode.TeamTargetChanged,
        )
        f.sessions[0].token = connection
        assert.deepEqual(
            current(),
            after,
            'A stale controller must not receive a new grant or change canonical progress',
        )
        assert.equal(f.teams.backend, null)
    } finally {
        f.close()
    }
})
