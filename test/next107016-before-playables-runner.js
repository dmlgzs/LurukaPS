import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { runCurrentWingsBridge } from './next107016-bridge-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { currentWingsStoryProfiles } from './next107016-story-profiles.js'

// Current binding0602f1ab maps2580/2590 to local bubble entities whose
// Execute only StepOver/Complate;2750 maps to the same local Common path.
// This models task actions,not the separate NPC bubble controllers or UI.
const localActions = new Set(['TaskNpcBubbleData', 'TaskNpcBubbleListData', 'TaskCoverPlayTalkData'])

export async function runCurrentWingsBeforePlayables({ outputDirectory, afterApproach } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-wings-approach-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, localActions: [] }
    await runCurrentWingsBridge({
        outputDirectory: directory,
        afterBridge({ f, driver, observer }) {
            const before = f.requestCount()
            assert.equal(before, 5632)
            proof.before = before
            const flow = normalSuccessorFlow(f, driver, {
                npcStoryCompletion(data) {
                    const profile = currentWingsStoryProfiles.get(data.storyId)
                    assert(profile, 'Exact current NPC story source required')
                    if (data.storyTag >= 0) assert.equal(profile[1], data.storyTag)
                    driver.playStory(data.storyId)
                },
                afterSourceAction(kind, data) {
                    if (!localActions.has(kind)) return false
                    assert.deepEqual(Object.keys(data), ['$type'])
                    proof.localActions.push({ kind, data })
                    return true
                },
            })
            try {
                while (f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id !== 21) {
                    assert(flow.visits.length < 12)
                    flow.step(107016)
                }
                const state = f.state(),
                    task = state.tasks.find((task) => task.task_id === 107016)
                assert.deepEqual(
                    task.nodes.map((node) => [node.node_id, node.node_values]),
                    [[21, [0]]],
                )
                assert.equal(state.playableFinishes?.[62043], undefined)
                assert.equal(state.playableRuns?.[62043], undefined)
                assert.equal(state.playableFinishes?.[62031], undefined)
                assert(!state.taskRecords.some((row) => row.task_id === 107016 && row.count > 0))
                const earned = state.player.basic_info
                f.coldLogin()
                assert.deepEqual(
                    f.state().tasks.find((task) => task.task_id === 107016),
                    task,
                )
                assert.deepEqual(f.state().player.basic_info, earned)
                const trace = observer.trace.slice(before)
                assert(!trace.some((row) => row.error))
                const transferId = f.protocol.byName.get('CSProtoEnterWorldMap').id
                const transfers = trace.filter((row) => row.id === transferId)
                assert.deepEqual(
                    transfers.map((row) => row.request.point_id),
                    [1001425, 10082],
                )
                assert(transfers.every((row) => row.request.task_id === 107016))
                const hits = trace.filter((row) => row.id === 10705)
                const expected = ((4n << 56n) | 107016016n).toString()
                assert.equal(hits.length, 2)
                assert(hits.every((row) => row.request.uint64_dic[1] === expected))
                assert.equal(hits[0].request.battle_info[0].hurt_info.hp_change, -1)
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    task: 107016,
                    node: 21,
                    map: f.state().world.map_id,
                    level: earned.lv,
                    visits: flow.visits,
                    target: expected,
                    transfers: transfers.map((row) => row.request),
                }
                const result = afterApproach?.({ f, driver, observer, flow })
                assert(!result?.then, 'Wings approach continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'wings-before-playables.json'),
                    JSON.stringify(
                        {
                            ...proof,
                            after: f.requestCount(),
                            actions: flow.actions,
                            trace: observer.trace.slice(before),
                            state: f.state(),
                        },
                        null,
                        2,
                    ) + '\n',
                )
            }
        },
    })
    return { directory, ...proof }
}
