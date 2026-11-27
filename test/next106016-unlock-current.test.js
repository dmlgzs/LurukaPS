import test from 'node:test'
import assert from 'node:assert/strict'
import { reachCurrent106016 } from './next106016-prerequisite.js'

test('natural3322 earns real paid material XP to20 and automatically admits106016 without task/level injection', async () => {
    const result = await reachCurrent106016({ outputDirectory: process.env.MAIN_106016_UNLOCK_ARTIFACTS })
    assert.equal(result.before.level, 15)
    assert.equal(result.before.exp, 2450)
    assert.equal(result.before.neededExperience, 17000)
    assert.equal(result.final.level, 20)
    assert.equal(result.final.exp, 100)
    assert.equal(result.final.paidRuns, 57)
    assert.equal(result.final.earnedExperience, 17100)
    assert.equal(result.final.spentStamina, 1710)
    assert.equal(result.final.task, 106016)
    assert.equal(result.final.node, 15)
})
