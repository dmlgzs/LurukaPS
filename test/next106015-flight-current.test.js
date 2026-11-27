import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentFlightMilestone } from './next106015-flight-runner.js'

test('natural3073 resumes zero-step flight then completes current nine-waypoint62035 without granting its local mount', async () => {
    const result = await runCurrentFlightMilestone({ outputDirectory: process.env.FLIGHT_62035_ARTIFACTS })
    assert.equal(result.before, 3073)
    assert.equal(result.after, 3099)
    assert.equal(result.final.node, 10)
    assert.equal(result.final.world.point_id, 1001461)
    assert.equal(result.local.filter((row) => row.kind === 'waypoint-arrived').length, 9)
    const steps = result.requests.filter((row) => row.name === 'PlayableStep')
    assert.equal(steps.length, 1)
    assert.equal(steps[0].value.finish_step, 3)
    assert.equal(result.requests.filter((row) => row.name === 'PlayableStart').length, 2)
    assert.equal(result.requests.filter((row) => row.name === 'PlayableFinish').length, 1)
})
