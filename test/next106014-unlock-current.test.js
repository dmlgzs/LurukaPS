import test from 'node:test'
import assert from 'node:assert/strict'
import { reachCurrent106014 } from './next106014-prerequisite.js'

test('natural791 continues through real commission2/3 and paid material XP to level15 and automatic106014 admission', async () => {
    const result = await reachCurrent106014()
    assert.equal(result.before.requests, 791)
    assert.equal(result.before.level, 8)
    assert.equal(result.before.exp, 1200, 'the actual earlier commission claim must include its advertised300 XP')
    assert.equal(result.final.requests, 2890)
    assert.equal(result.final.paidRuns, 58)
    assert.equal(result.final.stamina, '8230')
    assert.equal(result.final.exp, 0)
    assert.equal(result.final.level, 15)
    assert.equal(result.final.task, 106014)
    assert.equal(result.final.node, 3)
})
