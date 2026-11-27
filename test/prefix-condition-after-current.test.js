import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts =
    process.env.NORMAL_PREFIX_CORRECTION_ARTIFACTS ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-prefix-condition-after-'))
fs.mkdirSync(artifacts, { recursive: true })
process.env.NORMAL_SUCCESSOR_ARTIFACTS = artifacts
process.env.NORMAL_PROGRESSION_ARTIFACTS = artifacts
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [{ reachCurrent106012 }, { conditionAfterPhaseTrace }] = await Promise.all([
    import('./prefix-correction-prerequisite.js'),
    import('./prefix-correction-condition-phase.js'),
])

test('current normal prefix enumerates required condition-after queues and reports all four source-correct watches', () => {
    const context = reachCurrent106012()
    const { f } = context
    try {
        const trace = f.requestTrace(),
            phases = conditionAfterPhaseTrace(f)
        assert.equal(trace.length, 519, 'execute the complete current normal prefix, including four added watches')
        const ids = [101029, 101030, 101042, 101043]
        const reports = trace.filter((row) => row.id === 6060 && ids.includes(row.requestPayload?.story_id))
        assert.deepEqual(
            reports.map((row) => [
                row.requestPayload.story_id,
                row.requestPayload.story_type,
                row.requestPayload.tag,
                row.requestPayload.param,
                row.requestPayload.is_skip,
            ]),
            [
                [101029, 0, 0, 0, false],
                [101030, 0, 0, 0, false],
                [101042, 0, 0, 2, false],
                [101043, 0, 0, 2, false],
            ],
        )
        assert(
            phases.some(
                (row) => row.nodeId === 181 && row.kind === '__type_TaskBlackData' && row.phase === 'local-complete',
            ),
        )
        for (const [node, firstStory, lastStory] of [
            [103, 101029, 101030],
            [133, 101042, 101043],
        ]) {
            const first = trace.findIndex((row) => row.id === 6060 && row.requestPayload?.story_id === firstStory)
            const ack = trace.findIndex(
                (row) =>
                    row.id === 9863 && row.requestPayload?.task_id === 106010 && row.requestPayload.node_id === node,
            )
            const last = trace.findIndex((row) => row.id === 6060 && row.requestPayload?.story_id === lastStory)
            assert(first >= 0 && ack > first && last > ack, 'first watch -> full queue empty/ACK -> last watch')
            assert.deepEqual(trace[ack].requestPayload.indexes, [0, 1])
            assert(trace[ack].packets.includes(9863))
        }
        assert.equal(f.state().taskRecords.find((row) => row.task_id === 106010).count, 1)
        assert.deepEqual(
            f
                .state()
                .tasks.find((row) => row.task_id === 106012)
                .nodes.map((row) => row.node_id),
            [12],
        )
        fs.writeFileSync(
            path.join(artifacts, 'prefix-correction.json'),
            JSON.stringify(
                {
                    boundary:
                        'separate current-source action-phase model; original515 remains frozen actual coverage, not retroactively four-watch complete',
                    requests: trace.length,
                    reports,
                    phases,
                    final: f.summary(),
                },
                null,
                2,
            ) + '\n',
        )
    } finally {
        f.close()
    }
})
