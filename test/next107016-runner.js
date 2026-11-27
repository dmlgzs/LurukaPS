import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runCurrentFoodChapter } from './next106016-main-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { currentWingsStoryProfiles } from './next107016-story-profiles.js'
import { runCurrentTrackingDungeon } from './current-tracking-dungeon-model.js'

export async function runCurrentWingsTracking({ outputDirectory, afterTracking } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-tracking107016-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, events: [], watches: [] }
    await runCurrentFoodChapter({
        outputDirectory: directory,
        afterChapter({ f, driver, observer }) {
            const before = f.requestCount()
            assert.equal(before, 5543)
            proof.before = before
            const current = {
                ...driver,
                playStory(id) {
                    const profile = currentWingsStoryProfiles.get(id)
                    assert(profile, 'Current source profile unavailable: ' + id)
                    const [type, tag, clicks] = profile
                    assert.equal(f.tables.find('story', id).storyType, type)
                    driver.call('SetStoryId', { story_id: id, story_type: type, tag, param: clicks, is_skip: false })
                    proof.watches.push({ id, type, tag, clicks })
                },
            }
            const flow = normalSuccessorFlow(f, current, {
                npcStoryCompletion: (data) => {
                    const profile = currentWingsStoryProfiles.get(data.storyId)
                    assert(profile)
                    if (data.storyTag >= 0) assert.equal(profile[1], data.storyTag)
                    current.playStory(data.storyId)
                },
                dungeonCompletion(data, { taskId, node }) {
                    assert.equal(taskId, 107016)
                    assert.equal(node.id, 5)
                    assert.equal(data.dungeonId, 10200)
                    const marker =
                        node.__type_TaskConditionNodeData.conditionList[0].__type_TaskConditionBaseData.mapData.targetId
                    const source = current.graphs.get(taskId).npcs.find((npc) => npc.createNpcId === marker)
                    assert(source && source.sceneId === f.state().world.map_id)
                    current.move({ x: source.posX, y: source.posY, z: source.posZ })
                    runCurrentTrackingDungeon(f, current, proof.events)
                },
            })
            try {
                while (f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id !== 8) {
                    assert(flow.visits.length < 6)
                    flow.step(107016)
                }
                const earned = f.state(),
                    active = earned.tasks.find((task) => task.task_id === 107016)
                assert.deepEqual(
                    active.nodes.map((node) => node.node_id),
                    [8],
                )
                assert.equal(earned.world.map_id, 100)
                f.coldLogin()
                assert.deepEqual(
                    f.state().tasks.find((task) => task.task_id === 107016),
                    active,
                )
                assert.equal(f.state().storyCampaignClears[10200].count, 1)
                assert(!f.state().taskRecords.some((task) => task.task_id === 107016 && task.count > 0))
                const trace = observer.trace.slice(before)
                assert.equal(trace.filter((row) => row.error).length, 0)
                assert.equal(trace.filter((row) => row.id === 9403 && row.request.u32 === 62024).length, 1)
                assert.equal(trace.filter((row) => row.id === 9406 && row.request.playId === 62024).length, 1)
                assert.equal(trace.filter((row) => row.id === 9404 && row.request.playId === 62024).length, 1)
                assert(!trace.some((row) => row.id === 6060 && row.request.story_id === 0))
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    activeTask: 107016,
                    node: 8,
                    completedDungeon: 10200,
                    internalTask: 500024,
                    level: f.state().player.basic_info.lv,
                    exp: f.state().player.basic_info.exp,
                    visits: flow.visits,
                }
                const result = afterTracking?.({ f, driver: current, observer, flow })
                assert(!result?.then, 'Tracking continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'tracking107016.json'),
                    JSON.stringify(
                        {
                            ...proof,
                            after: f.requestCount(),
                            visits: flow.visits,
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
