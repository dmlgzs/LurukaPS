import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentWingsTracking } from './next107016-runner.js'

test('natural5543 enters current10200,follows source tracking observations and returns to main107016/8', async () => {
    const result = await runCurrentWingsTracking({ outputDirectory: process.env.MAIN_107016_TRACKING_ARTIFACTS })
    assert.equal(result.before, 5543)
    assert.equal(result.final.node, 8)
    assert.equal(result.final.completedDungeon, 10200)
    assert.equal(result.events.filter((event) => event.kind === 'trace-ready' && event.requestedStart).length, 1)
    assert.deepEqual(
        result.events.filter((event) => event.kind === 'trace-checkpoint-dialogue').map((event) => event.event),
        [1001, 1002],
    )
    assert.deepEqual(
        result.events.filter((event) => event.kind === 'trace-dialogue-reported').map((event) => event.id),
        [101214, 10121406, 101214, 10121405, 101214, 101215, 101216],
    )
    assert.equal(result.events.find((event) => event.kind === 'trace-success').observations.arrivals.length, 12)
    assert.equal(result.final.visits.at(-1).serverAdvanced, true)
})
