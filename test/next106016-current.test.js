import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentFoodApproach } from './next106016-runner.js'

test('natural5318 continues current106016 NPC,story and battle inputs to its actual guided condition without task injection', async () => {
    const result = await runCurrentFoodApproach({ outputDirectory: process.env.MAIN_106016_APPROACH_ARTIFACTS })
    assert.equal(result.before, 5318)
    assert.equal(result.final.task, 106016)
    assert.equal(result.final.node, 26)
    assert.equal(result.final.pendingGuided, 10049)
    assert.deepEqual(result.final.visits, [15, 16, 17, 18, 20, 21, 23, 24, 25])
    assert.equal(result.final.targets.length, 13)
    assert.equal(result.final.requests, 5419)
    assert.equal(result.hits.length, 26)
})
