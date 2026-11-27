import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentWingsMilestone } from './next106014-runner.js'
import { runCurrentCommonStoryDungeon } from './current-common-dungeon-story-model.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { currentShadowStoryProfiles } from './next106015-story-profiles.js'

// Genuine3033 prerequisite, not a save checkpoint. The continuation shares
// the same account, actual protocol dispatch and guarded RAM Store lifetime.
export async function runCurrentShadowApproach({ outputDirectory, afterApproach } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-shadow106015-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { boundary: 'Current source/normal account input model; no GM/save edits or Unity execution' }
    await runCurrentWingsMilestone({
        outputDirectory: directory,
        dungeonLifecycle: (context) => runCurrentCommonStoryDungeon(context, []),
        afterChapter({ f, driver, observer }) {
            const before = f.requestCount(),
                watches = []
            assert.equal(before, 3033)
            const current = {
                ...driver,
                playStory(id) {
                    const profile = currentShadowStoryProfiles.get(id)
                    assert(profile, 'Current story source missing: ' + id)
                    const [type, tag, clicks] = profile
                    assert.equal(f.tables.find('story', id).storyType, type)
                    driver.call('SetStoryId', { story_id: id, story_type: type, tag, param: clicks, is_skip: false })
                    watches.push({ id, type, tag, clicks })
                },
            }
            const flow = normalSuccessorFlow(f, current, {
                npcStoryCompletion: (data) => current.playStory(data.storyId),
            })
            try {
                while (f.state().tasks.find((row) => row.task_id === 106015).nodes[0].node_id !== 8) {
                    assert(flow.visits.length < 12)
                    flow.step(106015)
                }
                const node = current.graphs.get(106015).nodes.get(8)
                const condition = node.__type_TaskConditionNodeData.conditionList[0]
                const playable = condition.__type_TaskConditionBaseData.__type_TaskCondCompletePlayableData
                assert.equal(playable.playableId, 62035)
                assert.equal(f.state().tasks.find((row) => row.task_id === 106015).nodes[0].node_values[0], 0)
                assert.equal(
                    f.state().taskRecords.some((row) => row.task_id === 106015),
                    false,
                )
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    task: 106015,
                    node: 8,
                    playable: 62035,
                    world: f.state().world,
                }
                const result = afterApproach?.({ f, driver: current, observer, flow })
                assert(!result?.then, 'Approach continuation must run synchronously')
            } finally {
                Object.assign(proof, { before, after: f.requestCount(), visits: flow.visits, watches })
                fs.writeFileSync(
                    path.join(directory, 'shadow106015.json'),
                    JSON.stringify({ ...proof, trace: observer.trace.slice(before) }, null, 2) + '\n',
                )
            }
        },
    })
    return proof
}
