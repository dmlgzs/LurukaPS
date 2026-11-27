import { targetFixture, tables } from './team-v2-target-change-fixture.js'
import { compileSharedTeamTarget } from '../src/team-v2-run-target.js'

// Independent current target qualification. PRE_START/PLAY are trusted
// internal entry checkpoints,not a claimed public Ready/Start implementation.
export function sharedSceneFixture() {
    const f = targetFixture({ count: 2 }),
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
    const query = (who) => ({
        id: f.id(who),
        state: f.state(who),
        tables,
        now: f.now(),
        combatSessionId: f.sessions[who].token,
    })
    try {
        f.create()
        const compiled = compileSharedTeamTarget(tables, f.room())
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 3, ready: [f.id(0), f.id(1)] }, 0))
        transaction((c) => runs.admit(c, f.room()))
        for (const who of [0, 1])
            f.call(who, 'MultiCampaignCreate', { dungeon_id: compiled.definition.dungeonId, scene_type: 12 })
        transaction((c) => runs.bindScenes(c))
        transaction((c) => teams.commitRoom(c, { ...f.room(), state: 4 }, 0))
        for (const who of [0, 1]) f.call(who, 'EnterDungeonScene', { scene_id: compiled.route.scene.id })
        return { ...f, teams, runs, compiled, query, transaction }
    } catch (error) {
        f.close()
        throw error
    }
}
