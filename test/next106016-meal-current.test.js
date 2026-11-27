import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentFoodMeal } from './next106016-meal-runner.js'

test('natural5463 buys actual seeds,grows ingredients and claims five meals before reaching the real NPC signal', async () => {
    const result = await runCurrentFoodMeal({ outputDirectory: process.env.MAIN_106016_MEAL_ARTIFACTS })
    assert.equal(result.before, 5463)
    assert.equal(result.farm.filter((entry) => entry.kind === 'plant-water-claim').length, 2)
    assert.equal(result.cooking[0].request.cook_id, 1038)
    assert.equal(result.cooking[0].request.cook_count, 5)
    assert.equal(result.final.food, 5)
    assert.equal(result.final.node, 35)
    assert.deepEqual(result.final.visits, [31, 32, 33, 34])
    assert(result.rolls.length > 0)
})
