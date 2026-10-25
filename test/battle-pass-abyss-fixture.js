import assert from 'node:assert/strict'
import { battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'

export const taskId = 1001305
export const levelId = 20005
export const current = (f) =>
    battlePassTaskSnapshot(f.tables, f.state(), f.time.now).forever_task.find((row) => row.task_id === taskId)

export function enterTarget(f) {
    f.store.transact(f.session.id, 0, (state) => {
        // Unrelated entry prerequisites only. Target20005 is never injected;
        // its passed property must be produced by both actual battle rooms.
        state.abyss = { modes: { 1: { levels: {} }, 2: { levels: {} } } }
        for (let id = 10001; id <= 10007; id++) state.abyss.modes[1].levels[id] = { passed: true, star_num: 3 }
        for (let id = 20001; id < levelId; id++) state.abyss.modes[2].levels[id] = { passed: true, star_num: 3 }
    })
    f.call('AbyssChallenge', f.request(2, levelId))
    f.call('AbyssChallengeRealStart')
}

export function clearRoom(f, beforeFinalHit) {
    let packets = []
    let guard = 0
    while (f.state().abyssRun.phase !== 'won') {
        assert(guard++ < 100, 'the actual room must reach a terminal state')
        let state = f.state()
        if (state.abyssRun.phase === 'intro') {
            f.call('AbyssBossIntroDone', { stage_id: state.abyssRun.intro.stage_id })
            continue
        }
        const run = state.abyssRun
        assert.equal(run.phase, 'running')
        const targets = Object.values(state.combat.entities).filter(
            (row) => run.wave_objects.includes(row.object_id) && row.hp > 0,
        )
        assert(targets.length > 0)
        for (const target of targets) {
            state = f.state()
            const request = {
                uint64_dic: [state.abyssRun.challenges[state.abyssRun.part_index].control, target.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -target.hp } }],
            }
            beforeFinalHit?.(request)
            packets = f.call('BattleInfoReduce', request)
        }
    }
    return packets
}
