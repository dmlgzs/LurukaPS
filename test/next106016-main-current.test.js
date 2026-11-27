import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentFoodChapter } from './next106016-main-runner.js'

test('natural5515 follows source guide arrival/contact then finishes106016 and admits its current107016 successor', async () => {
    const result = await runCurrentFoodChapter({ outputDirectory: process.env.MAIN_106016_CHAPTER_ARTIFACTS })
    assert.equal(result.before, 5515)
    assert.equal(result.guides.length, 1)
    assert.equal(result.guides[0].state.visits.length, 7)
    assert.equal(result.final.count, 1)
    assert.equal(result.final.nextTask, 107016)
    assert.equal(result.final.exp, 1300)
    assert.deepEqual(result.final.visits, [35, 36, 37, 44])
})
