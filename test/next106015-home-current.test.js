import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentHomeApproach } from './next106015-home-runner.js'

test('natural3099 crosses real town/room/own-home portals and dynamic item callback before unfinished building guidance', async () => {
    const directory =
        process.env.HOME_APPROACH_106015_ARTIFACTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-home-approach-'))
    const result = await runCurrentHomeApproach({ outputDirectory: directory })
    assert.equal(result.before, 3099)
    assert.equal(result.after, 3156)
    assert.equal(result.final.node, 62)
    assert.deepEqual(
        result.visits.map((row) => row.nodeId),
        [10, 11, 12, 13, 14, 43, 73, 23],
    )
    const proof = JSON.parse(fs.readFileSync(path.join(directory, 'home-approach106015.json'), 'utf8'))
    assert.equal(proof.trace.filter((row) => row.error).length, 0)
    const entries = proof.trace.filter((row) => row.name === 'CSProtoEnterWorldMap').map((row) => row.request)
    assert.deepEqual(
        entries.map((row) => [row.map_id, row.point_id]),
        [
            [200, 20001],
            [250, 25001],
            [200, 20002],
            [701, 70101],
        ],
    )
    assert(entries.every((row) => !(row.task_id > 0) && !(row.node_id > 0) && row.creator_id === 1))
    assert.equal(proof.trace.filter((row) => row.name === 'CSProtoWorldObjInteract').length, 0)
    assert.equal(result.local.filter((row) => row.kind === 'dynamic-item-break-callback').length, 1)
    assert.equal(result.final.pendingGuided[0].condition, '12027|2017|1')
})
