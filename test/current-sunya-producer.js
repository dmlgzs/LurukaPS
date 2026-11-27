import assert from 'node:assert/strict'
import { currentSunyaInput } from './current-sunya-input.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { worldCondition } from '../src/handlers/world-objects.js'

export function runCurrentSunya(f, driver, data, context, events) {
    assert.deepEqual([context.taskId, context.node.id, data.playableID, data.sceneID], [107016, 21, 62043, 100])
    const row = f.tables.get('worldmap_100').find((row) => row.expandId === data.playableID)
    assert(row && worldCondition(row.appearCond, f.state()))
    const [x, y, z] = row.position.split('|').map((value) => Math.round(Number(value) * 100))
    driver.move({ x, y, z })
    const query = () => {
        const packets = driver.call('WorldObjEnemyInfo', { play_id: data.playableID, obj_id: row.id })
        const entry = f.protocol.byName.get('CSProtoWorldObjEnemyInfo')
        return f.protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload)
    }
    const info = query()
    assert.deepEqual(query(), info, 'The current source identity roster must stay stable')
    const input = currentSunyaInput(f.tables, info.monster_info.monsters)
    const progress = () => f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_values[0]
    assert.equal(progress(), 0)
    const hits = []
    for (let wave = 0; wave < input.definition.waves.length; wave++) {
        if (wave) {
            f.advanceMs(2000)
            input.advance(2)
        }
        // Local enemy creation and enter-battle callbacks are supplied,not
        // a simulation of enemy AI,range/occlusion or ForbidLeaveBattle.
        const active = input.enterBattle()
        if (active.needsStart) driver.call('PlayableStart', { u32: data.playableID })
        input.acknowledgeStart()
        assert.equal(f.state().playableRuns[62043].status, 1)
        for (const target of active.wave.targets) {
            const definition = enemyDefinition(f.tables, f.state(), target)
            assert(definition && definition.max_hp > 1)
            const hp = f.state().combat?.entities?.[target]?.hp ?? definition.max_hp
            for (const delta of [-1, -(hp - 1)]) {
                f.advanceMs(2)
                driver.call('BattleInfoReduce', {
                    base_time: String(f.nowMs()),
                    uint64_dic: [f.currentGroup().control, target],
                    battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
                })
            }
            assert.equal(f.state().combat.entities[target].hp, 0)
            input.observeDead(target)
            hits.push({ target, wave, index: active.wave.index, initialHp: hp })
        }
        input.observeWaveClear(active.wave.index)
        assert.equal(input.takeFinish(), null)
        assert.equal(progress(), 0)
        assert.equal(f.state().playableRuns[62043].finish_step, 0)
        events.push({ kind: 'sunya-wave-clear', wave, index: active.wave.index, killed: active.wave.targets.length })
    }
    for (const target of input.definition.ignored) assert.equal(f.state().combat.entities[target], undefined)
    f.advanceMs(2) // positive update after the current zero finalStoryDelay
    const step = input.beginFinalPerformance()
    driver.call('PlayableStep', { playId: 62043, is_step: true, finish_step: step, pos: { x, y, z } })
    assert.equal(progress(), 0)
    assert.equal(f.state().playableRuns[62043].status, 1)
    assert.equal(f.state().playableFinishes?.[62043], undefined)
    // Current core prefab has a [Playable1] director. A successful local
    // playback-end observation is supplied;external timeline duration and
    // Unity rendering are not executed or assigned an invented duration.
    input.observeFinalDirectorEnd()
    const complete = input.takeFinish()
    assert.deepEqual(complete, { playId: 62043, step: 10 })
    // OnFinish calls the finish helper,and its synchronous AllFinish output
    // reaches PlayableStop which calls it again. Model both invocations
    // queued before the first network reply,not a convenient ACK interleave.
    const queued = [0, 1].flatMap(() => [
        {
            name: 'PlayableStep',
            data: { playId: complete.playId, is_step: true, finish_step: complete.step, pos: { x, y, z } },
        },
        { name: 'PlayableFinish', data: { playId: complete.playId, index: 0, score: 0, pos: { x, y, z } } },
    ])
    events.push({ kind: 'sunya-completion-calls-queued', requests: structuredClone(queued) })
    for (const [index, request] of queued.entries()) {
        driver.call(request.name, request.data)
        if (index === 0) assert.equal(progress(), 0, 'Completed step alone is not a task completion receipt')
    }
    assert.equal(progress(), 1)
    assert.equal(input.takeFinish(), null)
    events.push({
        kind: 'sunya-success',
        definition: input.definition,
        observations: input.snapshot(),
        hits,
        schedule:
            'Two source finish-helper invocations queued before replies,then real ordered server dispatch;Unity or transport timing is not executed',
    })
}
