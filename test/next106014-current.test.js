import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentWingsMilestone } from './next106014-runner.js'

test('natural level15 chapter106014 traverses its NPC nodes and complete declared dungeon route without first-scene credit', async () => {
    const result = await runCurrentWingsMilestone({ outputDirectory: process.env.WINGS_106014_ARTIFACTS })
    assert.equal(result.before, 2890)
    assert.equal(result.final.waves, 5)
    assert.equal(result.rejected.length, 3)
    assert.equal(result.final.world.point_id, 10083)
    assert.equal(result.final.record.count, 1)
})
