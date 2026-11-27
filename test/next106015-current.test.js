import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentShadowApproach } from './next106015-runner.js'

test('natural3033 continues through current106015 NPC and text-backed story choices to the actual62035 prerequisite', async () => {
    const result = await runCurrentShadowApproach({ outputDirectory: process.env.SHADOW_106015_ARTIFACTS })
    assert.equal(result.before, 3033)
    assert.equal(result.after, 3073)
    assert.deepEqual(
        result.visits.map((row) => row.nodeId),
        [71, 3, 4, 5, 6, 7],
    )
    assert.equal(result.final.node, 8)
    assert.equal(result.final.playable, 62035)
    assert.equal(result.final.world.map_id, 100)
    assert.equal(result.watches.find((row) => row.id === 101113).clicks, 2)
    assert.equal(result.watches.find((row) => row.id === 101116).clicks, 1)
})
