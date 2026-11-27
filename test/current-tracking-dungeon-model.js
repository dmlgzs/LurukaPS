import assert from 'node:assert/strict'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { currentTaskTraceInput } from './current-task-trace-input.js'
import { storyCampaignConfig } from '../src/story-campaign.js'

// Current hotfix TaskTraceModule control callbacks and source AI arrival
// observations drive actual RPCs. No Unity,visibility or NavMesh execution.
export function runCurrentTrackingDungeon(f, driver, events) {
    const config = storyCampaignConfig(f.tables, 248, 1)
    assert.equal(config.dungeon.id, 10200)
    assert.deepEqual(config.taskIds, [500024])
    assert.deepEqual(
        config.scenes.map(({ city }) => city.id),
        [6250],
    )
    const beforeWorld = f.state().world
    const ownership = () => ({
        heroes: f.state().player.heros_info.heros.map(({ guid, conf_id }) => [guid, conf_id]),
        pets: f.state().pets.map(({ guid, config_id }) => [guid, config_id]),
    })
    const ownedBefore = ownership()
    const packets = driver.call('CampaignCreate', { group_id: 248, difficulty: 1 })
    const info = packets.find((packet) => packet.id === 9505)
    assert(info)
    const snapshot = f.protocol.decode(f.protocol.byId.get(9505).rsp, info.payload)
    assert.equal(snapshot.dungeon_id, 10200)
    assert.equal(snapshot.dungeon_instance_id, 10200)
    assert.equal(snapshot.cur_scene_id, 6250)
    assert.deepEqual(
        snapshot.scene_datas.map((scene) => scene.scene_id),
        [6250],
    )
    driver.call('MapLoadFinish')
    driver.call('StartDungeonClientOk')
    assert.equal(f.state().world.map_id, 6250)
    const child = normalSuccessorFlow(f, driver, {
        playableCompletion(data, { taskId, node }) {
            assert.equal(taskId, 500024)
            assert.equal(node.id, 2)
            assert.equal(data.playableId, 62024)
            const input = currentTaskTraceInput(f.tables)
            const dialogue = (id, callback = () => {}) => {
                const type = f.tables.find('story', id)?.storyType
                assert([0, 2].includes(type))
                const rows = f.tables.get('story_convenient').filter((row) => row.story_id === id)
                const callbackAtStart = type === 2 && rows.length && rows.every((row) => row.type_callback === 0)
                if (type === 2)
                    assert(rows.length && rows.every((row) => row.type_callback === (callbackAtStart ? 0 : 1)))
                // FreedomDialogGroup06005b0c/0e: type_callback0 calls the
                // external callback at start;1 after6060 on stop. Choose full
                // playback before later movement,not an invented duration.
                events.push({ kind: 'trace-dialogue-begin', id, callbackAtStart: Boolean(callbackAtStart) })
                if (callbackAtStart) callback()
                driver.playStory(id)
                events.push({ kind: 'trace-dialogue-reported', id })
                if (!callbackAtStart) callback()
            }
            const move = (position) =>
                driver.move({
                    x: Math.round(position.x * 100),
                    y: Math.round(position.y * 100),
                    z: Math.round(position.z * 100),
                })
            const reset = () => {
                const ready = input.prepare()
                move(ready.playerPosition)
                f.advanceMs(100) // actual BP reset-complete delay after the explicit ready observation
                if (ready.needsStart) driver.call('PlayableStart', { u32: 62024 })
                assert.equal(f.state().playableRuns[62024].status, 1)
                assert.equal(f.state().playableRuns[62024].finish_step, 0)
                input.acknowledgeStart()
                input.start()
                dialogue(input.definition.dialogues.start, () => input.startDialogueCallback())
                events.push({ kind: 'trace-ready', requestedStart: ready.needsStart })
            }
            reset()
            const actor = input.definition.points[0]
            move({ ...actor, x: actor.x + 40 })
            input.observePlayer({ ...actor, x: actor.x + 40 })
            assert.equal(input.takeFinish(), null)
            dialogue(input.definition.dialogues.tooFar, () => {
                f.advanceMs(2000) // BP delay after the end callback,not after dialog start
                input.failureCallbacksElapsed()
            })
            assert.equal(f.state().playableRuns[62024].finish_step, 0)
            events.push({ kind: 'trace-lost-no-progress' })
            reset()
            move(actor)
            f.advanceMs(2000)
            // Found is an observed local alert callback,not a simulated raycast or meter calculation.
            input.observePlayer(actor, { found: true })
            assert.equal(input.takeFinish(), null)
            dialogue(input.definition.dialogues.found, () => {
                f.advanceMs(3000) // current found callback delay2 + failed-message delay1
                input.failureCallbacksElapsed()
            })
            events.push({ kind: 'trace-found-no-progress' })
            reset()
            let previous = actor
            for (const [index, point] of input.definition.points.entries()) {
                f.advanceMs(
                    Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) / 3 + 1) *
                        1000,
                )
                const checkpoint = input.arrive(index, point)
                const direction = index
                    ? { x: point.x - previous.x, z: point.z - previous.z }
                    : { x: input.definition.points[1].x - point.x, z: input.definition.points[1].z - point.z }
                const length = Math.hypot(direction.x, direction.z)
                assert(length > 0)
                const player = {
                    x: point.x - (10 * direction.x) / length,
                    y: point.y,
                    z: point.z - (10 * direction.z) / length,
                }
                move(player)
                // A safe local alert/occlusion observation is supplied;the
                // network movement alone does not prove visibility physics.
                input.observePlayer(player)
                if (checkpoint) {
                    assert.equal(input.checkDestination(), false)
                    const dialogueId = input.definition.dialogues.checkpoints[checkpoint - 1001]
                    dialogue(dialogueId, () => input.checkpointEnd(checkpoint))
                    events.push({ kind: 'trace-checkpoint-dialogue', event: checkpoint, index, dialogueId })
                }
                assert.equal(f.state().playableRuns[62024].finish_step, 0)
                previous = point
            }
            assert.equal(input.checkDestination(), true)
            f.advanceMs(1000)
            input.advanceArrival(1)
            const finish = input.takeFinish()
            assert.deepEqual(finish, { success: true, finalStep: 50 })
            assert.equal(input.takeFinish(), null)
            const stepPackets = driver.call('PlayableStep', {
                playId: 62024,
                is_step: true,
                finish_step: finish.finalStep,
            })
            const sync = stepPackets.find((packet) => packet.id === 9400)
            assert(sync)
            const delta = f.protocol.decode(f.protocol.byId.get(9400).rsp, sync.payload)
            assert.equal(delta.all_sync, false)
            assert.equal(delta.plays.find((play) => play.play_id === 62024).status, 2)
            assert.equal(f.state().playableFinishes?.[62024], undefined)
            assert.equal(f.state().tasks.find((task) => task.task_id === 500024).nodes[0].node_values[0], 0)
            driver.call('PlayableFinish', { playId: 62024, index: 0, score: 0 })
            assert.equal(f.state().tasks.find((task) => task.task_id === 500024).nodes[0].node_values[0], 1)
            events.push({ kind: 'trace-success', definition: input.definition, observations: input.snapshot() })
        },
    })
    child.step(500024)
    child.step(500024)
    assert.equal(f.state().storyCampaign, undefined)
    assert.equal(f.state().world.map_id, beforeWorld.map_id)
    assert.deepEqual(f.state().world.pos, beforeWorld.pos)
    assert.equal(f.state().storyCampaignClears[10200].count, 1)
    assert.equal(f.state().taskRecords.find((task) => task.task_id === 500024).count, 1)
    assert.deepEqual(ownership(), ownedBefore)
    events.push({ kind: 'tracking-dungeon-auto-return', childVisits: child.visits, world: f.state().world.map_id })
}
