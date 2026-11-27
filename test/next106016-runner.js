import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reachCurrent106016 } from './next106016-prerequisite.js'
import { currentFoodStoryProfiles } from './next106016-story-profiles.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { taskSnapshot } from '../src/tasks.js'

// Genuine5318 normal prerequisite. Explicit successful local NPC time-window,
// movement/story and HP inputs; no task/level/asset edit, Unity or AI claim.
export async function runCurrentFoodApproach({ outputDirectory, afterApproach } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-food106016-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, watches: [], localInputs: [], hits: [] }
    await reachCurrent106016({
        outputDirectory: directory,
        afterUnlock({ f, driver, observer }) {
            const before = f.requestCount()
            assert.equal(before, 5318)
            const current = {
                ...driver,
                call(name, value = {}) {
                    const packets = driver.call(name, value)
                    // This proof belongs to the approach ending at node26.
                    // Later continuations can fight after106016 has finished.
                    if (name === 'BattleInfoReduce' && proof.final === null) {
                        const target = value.uint64_dic[1]
                        const hp = f.state().combat.entities[target]?.hp
                        assert(Number.isFinite(hp) && hp >= 0)
                        proof.hits.push({
                            target,
                            mapId: f.state().world.map_id,
                            nodeId: f.state().tasks.find((row) => row.task_id === 106016).nodes[0].node_id,
                            delta: value.battle_info[0].hurt_info.hp_change,
                            hp,
                        })
                    }
                    return packets
                },
                playStory(id) {
                    const profile = currentFoodStoryProfiles.get(id)
                    assert(profile, 'Current106016 story source is required: ' + id)
                    const [type, tag, clicks] = profile
                    assert.equal(f.tables.find('story', id).storyType, type)
                    driver.call('SetStoryId', { story_id: id, story_type: type, tag, param: clicks, is_skip: false })
                    proof.watches.push({ id, type, tag, clicks })
                },
            }
            const flow = normalSuccessorFlow(f, current, {
                npcStoryCompletion: (data) => current.playStory(data.storyId),
            })
            proof.before = before
            try {
                while (f.state().tasks.find((row) => row.task_id === 106016).nodes[0].node_id !== 26) {
                    assert(flow.visits.length < 15)
                    const nodeId = f.state().tasks.find((row) => row.task_id === 106016).nodes[0].node_id
                    const config = current.graphs.get(106016).nodes.get(nodeId)
                    for (const condition of config.__type_TaskConditionNodeData?.conditionList ?? []) {
                        const data = condition.__type_TaskConditionBaseData.__type_TaskCondActiveNPCTriggerData
                        if (data?.hasTime) {
                            assert.equal(nodeId, 15)
                            assert.equal(data.startTime, 10)
                            assert.equal(data.endTime, 14)
                            proof.localInputs.push({
                                kind: 'NPC time-window available',
                                nodeId,
                                start: 10,
                                end: 14,
                                boundary:
                                    'Successful client-local availability input;not an inferred WorldTimeSync unit or backend clock formula',
                            })
                        }
                    }
                    flow.step(106016)
                }
                const active = f.state().tasks.find((row) => row.task_id === 106016)
                assert.deepEqual(
                    active.nodes.map((row) => row.node_id),
                    [26],
                )
                assert.deepEqual(active.nodes[0].node_values, [0])
                const snapshot = taskSnapshot(f.tables, f.state())
                assert.equal(snapshot.next_main_id, 0)
                assert(snapshot.tasks.some((row) => row.task_id === 106016))
                assert(!f.state().taskRecords.some((row) => row.task_id === 106016 && row.count > 0))
                const earned = f.state()
                f.coldLogin()
                assert.deepEqual(
                    f.state().tasks.find((row) => row.task_id === 106016),
                    active,
                )
                assert.deepEqual(f.state().player.basic_info, earned.player.basic_info)
                const trace = observer.trace.slice(before)
                assert.equal(trace.filter((row) => row.error).length, 0)
                const damage = trace.filter((row) => row.id === 10705)
                const targets = [...new Set(damage.map((row) => row.request.uint64_dic[1]))]
                assert(targets.length > 0)
                assert.equal(proof.hits.length, damage.length)
                assert(targets.every((id) => proof.hits.some((hit) => hit.target === id && hit.hp === 0)))
                // Actual world transitions discard old scene combat runtime.
                // Keep the kill observations at their event, not as a demand
                // that dead enemies remain in the home scene after cold login.
                assert(targets.every((id) => !f.state().combat.entities[id]))
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    task: 106016,
                    node: 26,
                    pendingGuided: 10049,
                    level: f.state().player.basic_info.lv,
                    exp: f.state().player.basic_info.exp,
                    targets,
                    visits: flow.visits.map((row) => row.nodeId),
                }
                const result = afterApproach?.({ f, driver: current, observer, flow })
                assert(!result?.then, 'Approach continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'food106016.json'),
                    JSON.stringify(
                        {
                            ...proof,
                            after: f.requestCount(),
                            visits: flow.visits,
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
