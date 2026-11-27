import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentWingsSunya } from './next107016-sunya-runner.js'
test('normal5694 runs the two enabled sunya waves and real finish receipt before task107016/22', async () => {
    const result = await runCurrentWingsSunya({ outputDirectory: process.env.MAIN_107016_SUNYA_ARTIFACTS })
    assert.equal(result.before, 5694)
    assert.equal(result.final.node, 22)
    assert.deepEqual(
        result.events.filter((row) => row.kind === 'sunya-wave-clear').map((row) => row.killed),
        [4, 5],
    )
    const success = result.events.find((row) => row.kind === 'sunya-success')
    assert.equal(success.hits.length, 9)
    assert.equal(success.definition.ignored.length, 8)
    assert.equal(success.observations.localObservationsOnly, true)
})
