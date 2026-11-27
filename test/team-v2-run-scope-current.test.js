import test from 'node:test'
import assert from 'node:assert/strict'
import { targetFixture, tables } from './team-v2-target-change-fixture.js'
import { sceneRoute, sceneRoutingInfo, sceneAudienceMetadata, sceneAudienceAllows } from '../src/scene-routing.js'
import { ErrorCode } from '../src/error-codes.js'

test('durable shared admission and bound scene scopes isolate an outsider and revoke cached delivery without peer saves', () => {
    const f = targetFixture(),
        teams = f.game.teamV2,
        runs = teams.runs
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
    const route = (who) => sceneRoutingInfo(f.store, tables, f.id(who), runs)
    try {
        f.create(2)
        const normalRoom = structuredClone(f.room())
        assert.equal(teams.backend, null)
        assert.throws(
            () => f.call(0, 'TeamV2StartPrepare', { team_id: normalRoom.id }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.room(), normalRoom)

        // Explicit trusted PRE_START checkpoint for this internal component.
        // Not a produced11844/11846 Ready/Start flow or a multiplayer test.
        transaction((c) =>
            teams.commitRoom(
                c,
                {
                    ...f.room(),
                    state: 3,
                    ready: f.room().members.map((member) => member.id),
                },
                0,
            ),
        )
        const peerBefore = f.store.playerById.get(f.id(1)),
            admitted = transaction((c) => runs.admit(c, f.room()))
        assert.equal(admitted.run.phase, 'admitting')
        assert.equal(admitted.run.map_id, tables.find('dungeon_scene', 646).id)
        assert.deepEqual(
            admitted.run.members.map((member) => member.id),
            [f.id(0), f.id(1)],
        )
        assert.deepEqual(f.store.playerById.get(f.id(1)), peerBefore)

        // Three actual public private entries deliberately start with equal
        // map IDs/local instance counters. None alone establishes sharing.
        const dungeon = tables.find('dungeon_material', 10101)
        f.call(0, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })
        f.call(1, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })
        f.call(2, 'MultiCampaignCreate', { dungeon_id: dungeon.dungeonId, scene_type: 12 })
        assert.equal(f.state(0).world.map_id, f.state(2).world.map_id)
        assert.equal(f.state(0).entrust.run.instance_id, f.state(2).entrust.run.instance_id)
        assert.notEqual(route(0).scope, route(1).scope)
        const beforeBind = [f.state(0), f.state(1)]
        assert.throws(
            () =>
                transaction((c) => {
                    runs.bindScenes(c)
                    throw Error('abort shared binding')
                }),
            /abort shared binding/,
        )
        assert.deepEqual([f.state(0), f.state(1)], beforeBind)
        assert.equal(runs.read(admitted.run.id).phase, 'admitting')

        const bound = transaction((c) => runs.bindScenes(c))
        assert.equal(bound.run.phase, 'loading')
        assert.notEqual(route(0).scope, route(1).scope, 'The room has not entered its PLAY phase')
        // Trusted future-backend PLAY checkpoint, using the real room writer.
        // This does not send PLAY8 or claim shared NPC/controller/HP support.
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 4 }, 0))
        assert.equal(route(0).scope, route(1).scope)
        assert.match(route(0).scope, /^team-v2:team-v2-run:/)
        assert.notEqual(route(0).scope, route(2).scope)
        const audience = { kind: 'map', map: f.state(0).world.map_id, sender: f.id(0) },
            metadata = sceneAudienceMetadata(tables, f.state(0), f.id(0), audience, runs)
        assert(sceneAudienceAllows(route(1), audience, metadata.sceneScope))
        assert(!sceneAudienceAllows(route(2), audience, metadata.sceneScope))
        const outsider = structuredClone(f.state(2))
        outsider.sharedTeamRun = structuredClone(f.state(0).sharedTeamRun)
        assert(
            !sceneAudienceAllows(sceneRoute(tables, outsider, f.id(2), runs), audience, metadata.sceneScope),
            'Copying an admitted reference cannot create authoritative team membership',
        )
        assert.deepEqual(f.state(0).entrust.run, beforeBind[0].entrust.run)
        assert.deepEqual(f.state(1).entrust.run, beforeBind[1].entrust.run)

        const connection = f.sessions[1].token
        f.sessions[1].token = connection + ':replacement'
        assert(
            !sceneAudienceAllows(route(1), audience, metadata.sceneScope),
            'A changed connection cannot reuse the old scene admission/cache',
        )
        f.sessions[1].token = connection
        assert(sceneAudienceAllows(route(1), audience, metadata.sceneScope))

        const peer = f.store.playerById.get(f.id(1)),
            token = f.store.readCacheToken(f.id(1))
        transaction((c) => runs.close(c))
        assert.equal(f.store.readCacheToken(f.id(1)), token)
        assert.deepEqual(f.store.playerById.get(f.id(1)), peer)
        assert(
            !sceneAudienceAllows(route(1), audience, metadata.sceneScope),
            'Run revision/phase revokes a cached scope even without a player save',
        )
        assert.equal(teams.backend, null)
    } finally {
        f.close()
    }
})
