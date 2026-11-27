import test from 'node:test'
import assert from 'node:assert/strict'
import { runCurrentWingsBridge } from './next107016-bridge-runner.js'

test('normal tracking return clears the three existing task enemies and repairs the bridge once before107016/12', async () => {
    const result = await runCurrentWingsBridge({ outputDirectory: process.env.MAIN_107016_BRIDGE_ARTIFACTS })
    assert.equal(result.before, 5598)
    assert.equal(result.final.node, 12)
    assert.deepEqual(
        result.final.visits.map((row) => row.nodeId),
        [8, 9, 10, 11],
    )
    const group = result.events.find((row) => row.kind === 'existing-enemies-all-removed-input')
    assert.equal(group.group, 107016014)
    assert.equal(group.targets.length, 3)
    assert(group.targets.every((row) => row.initialHp > 1))
    const bridge = result.events.find((row) => row.kind === 'current-bridge-repair')
    assert.deepEqual(bridge.spent, { item: 300000, count: 20 })
    assert.equal(bridge.before - bridge.after, 20)
    assert.equal(bridge.delta.find((row) => row.obj_id === 902631).active, true)
    for (const id of [902632, 902633, 902634, 902635])
        assert.equal(bridge.delta.find((row) => row.obj_id === id).active, false)
})
