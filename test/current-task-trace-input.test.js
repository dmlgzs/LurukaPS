import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { currentTaskTraceInput } from './current-task-trace-input.js'

const tables = new Tables(configuration().tables)
const started = () => {
    const input = currentTaskTraceInput(tables)
    input.prepare()
    input.acknowledgeStart()
    input.start()
    input.startDialogueCallback()
    return input
}
const follow = (input) => {
    for (const [index, point] of input.definition.points.entries()) {
        const event = input.arrive(index, point)
        if (event) input.checkpointEnd(event)
    }
}

test('current trace resolves twelve source points,marker2/3 and checkpoint overrides2/5', () => {
    const input = currentTaskTraceInput(tables)
    assert.equal(input.definition.points.length, 12)
    assert.deepEqual(input.definition.checkpoints, [
        [2, 1001],
        [5, 1002],
    ])
    assert.equal(input.definition.lostDistance, 30)
    assert.deepEqual(input.definition.dialogues, {
        start: 101214,
        alerts: [10121402, 10121403, 10121404],
        found: 10121405,
        tooFar: 10121406,
        checkpoints: [101215, 101216],
    })
    assert.equal(input.definition.arriveDelay, 1)
    assert.equal(input.takeFinish(), null)
    assert.equal(input.checkDestination(), false)
})

test('checkpoint callbacks pause observations and must finish before later arrivals or completion', () => {
    const input = started()
    assert.throws(() => input.arrive(1, input.definition.points[1]), /follow the current AI path/)
    for (let index = 0; index <= 2; index++) input.arrive(index, input.definition.points[index])
    assert.equal(input.snapshot().phase, 'checkpoint')
    input.observePlayer({ x: 10000, y: 0, z: 0 })
    assert.equal(
        input.snapshot().phase,
        'checkpoint',
        'TaskTraceModule ignores range callbacks while checkpoint playback is paused',
    )
    assert.equal(input.checkDestination(), false)
    assert.throws(() => input.arrive(3, input.definition.points[3]))
    input.checkpointEnd(1001)
    assert.equal(input.snapshot().phase, 'playing')
})

test('start callback gates observations and current30m boundary uses ordinary3D distance', () => {
    const input = currentTaskTraceInput(tables)
    input.prepare()
    input.acknowledgeStart()
    input.start()
    const actor = input.definition.points[0]
    input.observePlayer({ ...actor, x: actor.x + 40 })
    assert.equal(input.snapshot().phase, 'start-dialogue')
    assert.throws(() => input.arrive(0, actor))
    input.startDialogueCallback()
    input.observePlayer({ ...actor, y: actor.y + 30 })
    assert.equal(input.snapshot().phase, 'playing')
    input.observePlayer({ ...actor, y: actor.y + 30.01 })
    assert.equal(input.snapshot().phase, 'too-far')
    assert.equal(input.takeFinish(), null)
})

test('lost/found callbacks do not create completion and reset only the local target while retaining root Start', () => {
    for (const reason of ['lost', 'found']) {
        const input = started()
        const point = input.definition.points[0]
        input.observePlayer(reason === 'lost' ? { ...point, x: point.x + 40 } : point, { found: reason === 'found' })
        assert.equal(input.takeFinish(), null)
        assert.equal(input.checkDestination(), false)
        input.failureCallbacksElapsed()
        assert.equal(input.prepare().needsStart, false)
        input.start()
        assert.equal(input.snapshot().phase, 'start-dialogue')
        input.startDialogueCallback()
        assert.equal(input.snapshot().next, 0)
        assert.equal(input.takeFinish(), null)
    }
})

test('the qualified complete path only emits one finish after the actual destination timer', () => {
    const input = started()
    follow(input)
    assert.equal(input.checkDestination(), true)
    assert.equal(input.checkDestination(), false)
    input.advanceArrival(0.5)
    assert.equal(input.takeFinish(), null)
    input.advanceArrival(0.5)
    assert.deepEqual(input.takeFinish(), { success: true, finalStep: 50 })
    assert.equal(input.takeFinish(), null)
})
