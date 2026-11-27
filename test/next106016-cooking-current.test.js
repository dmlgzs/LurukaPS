import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentFoodCooking } from './next106016-cooking-runner.js'

test('natural5419 cooks and claims actual popcorn then follows current task/NPC/transfer route to the next food goal', async () => {
    const result = await runCurrentFoodCooking({ outputDirectory: process.env.MAIN_106016_COOKING_ARTIFACTS })
    assert.equal(result.before, 5419)
    assert.equal(result.cooking.length, 1)
    assert.equal(result.cooking[0].request.cook_id, 1003)
    assert.equal(result.cooking[0].ingredientAfter, result.cooking[0].ingredientBefore - 6)
    assert.equal(result.cooking[0].stockAfter, 1)
    assert.equal(result.final.node, 31)
    assert.equal(result.final.pendingGuided, 10020)
    assert.deepEqual(result.final.visits, [26, 27, 28, 29, 30, 45])
})
