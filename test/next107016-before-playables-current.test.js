import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentWingsBeforePlayables } from './next107016-before-playables-runner.js'

test('normal bridge continuation follows current transfers,battle slots and stories without completing the next playables', async () => {
    const result = await runCurrentWingsBeforePlayables({ outputDirectory: process.env.MAIN_107016_APPROACH_ARTIFACTS })
    assert.equal(result.before, 5632)
    assert.equal(result.final.node, 21)
    assert.deepEqual(
        result.final.visits.map((row) => row.nodeId),
        [12, 13, 14, 15, 16, 17, 18, 19, 20],
    )
    assert.equal(result.localActions.filter((row) => row.kind === 'TaskNpcBubbleData').length, 3)
    assert.equal(result.localActions.filter((row) => row.kind === 'TaskNpcBubbleListData').length, 2)
    assert.equal(result.localActions.filter((row) => row.kind === 'TaskCoverPlayTalkData').length, 1)
})
