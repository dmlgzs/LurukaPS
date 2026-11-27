import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentSunyaMilestone } from './next106013-sunya-runner.js'

export async function runCurrentMemoryMilestone({ artifactRoot, afterMemory } = {}) {
    const base =
        artifactRoot ??
        process.env.NORMAL_106013_ARTIFACTS ??
        fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-memory62026-'))
    const artifacts = path.join(base, 'memory')
    const local = [],
        watches = [],
        seen = new Set()
    let before, final, taskSyncProof
    try {
        await runCurrentSunyaMilestone({
            artifacts,
            continuePlayableCompletion(data, { f, driver, call, taskId, node, index }) {
                assert.equal(data.playableId, 62026)
                assert.equal(taskId, 106013)
                assert.equal(node.id, 6)
                const row = f.tables.find('playable', 62026)
                assert.equal(row.type, 47)
                assert.equal(row.stepMax, 0)
                const origin = { x: data.playableData.posX, y: data.playableData.posY, z: data.playableData.posZ }
                assert.deepEqual(origin, { x: 21450, y: 14400, z: -32200 })
                driver.move(origin)
                // Current graph enters Init inside15m and sends9403. The five
                // distinct current child handles below are local UI inputs,
                // not invented world-object completion or owned NPC assets.
                call('PlayableStart', { u32: 62026 })
                local.push({ kind: 'current-range-init', playable: 62026, range: 15 })
                const handles = [
                    { tag: 'npc_0', spawner: 700456, story: 101059 },
                    { tag: 'npc_1', spawner: 700459, story: 101060 },
                    { tag: 'npc_2', spawner: 700460, story: 101063 },
                    { tag: 'npc_3', spawner: 700461, story: 101062 },
                    { tag: 'npc_4', spawner: 700448, story: 101061 },
                ]
                for (const handle of handles) {
                    assert(!seen.has(handle.tag), 'a hidden local interaction cannot be clicked twice')
                    seen.add(handle.tag)
                    assert(f.tables.find('world_spawner', handle.spawner))
                    assert.equal(f.tables.find('story', handle.story).storyType, 2)
                    local.push({ kind: 'start-current-insertion-story', ...handle })
                    // Child Split starts story, then synchronously dispatches
                    //1002(count), then1000(check). It does not count storyEnd.
                    local.push({ kind: 'distinct-click', ...handle, count: seen.size, events: [1002, 1000] })
                    if (seen.size === 5) local.push({ kind: 'exact-count-success', count: 5, waitEndStorySeconds: 4 })
                    // Explicit no-choice automatic dialogue completion, no UI
                    //screen clicks. It may finish during the four-second wait;
                    //this model chooses completion before localStop, not as a
                    //count source or a mandatory native packet schedule.
                    call('SetStoryId', { story_id: handle.story, story_type: 2, tag: 0, param: 0, is_skip: false })
                    watches.push(handle.story)
                }
                assert.equal(seen.size, 5)
                f.advanceMs(4000)
                local.push({ kind: 'current-four-second-wait-completed', milliseconds: 4000 })
                // Current Stop success invokes SetComplete; stepMax0 follows
                //the recovered helper fallback1, not an arbitrary task step.
                call('PlayableStep', { playId: 62026, is_step: true, finish_step: 1, pos: origin })
                const packets = call('PlayableFinish', { playId: 62026, score: 0, pos: { x: 0, y: 0, z: 0 } })
                assert.equal(f.state().playableFinishes[62026].map_id, 100)
                const task = packets
                    .filter((packet) => packet.id === 9853)
                    .flatMap((packet) => f.protocol.decode(f.protocol.byId.get(packet.id).rsp, packet.payload).tasks)
                    .find((value) => value.task_id === taskId)
                const synced = task?.nodes.find((value) => value.node_id === node.id)
                assert(synced?.node_values[index] >= 1, 'real9404→9853 supplies modern condition completion')
                taskSyncProof = { taskId, nodeId: node.id, index, values: synced.node_values }
            },
            afterMilestone({ f, driver, flow, observer }) {
                before = f.requestCount()
                assert.equal(before, 661, 'shared runner must genuinely complete the frozen Sunya prefix')
                try {
                    flow.step(106013)
                    assert.equal(f.state().tasks.find((task) => task.task_id === 106013).nodes[0].node_id, 11)
                    assert.equal(f.state().world.map_id, 100)
                    assert.equal(observer.trace.length, f.requestCount())
                    const delta = observer.trace.slice(before)
                    assert.equal(delta.filter((entry) => entry.id === 9904 && entry.request.key === 2525).length, 0)
                    assert.deepEqual(
                        delta.filter((entry) => entry.id === 6060).map((entry) => entry.request.story_id),
                        [101059, 101060, 101063, 101062, 101061],
                    )
                    assert(delta.every((entry) => !entry.error))
                    final = { requests: f.requestCount(), newRequests: f.requestCount() - before, summary: f.summary() }
                    afterMemory?.({ f, driver, observer })
                } finally {
                    final ??= {
                        requests: f.requestCount(),
                        newRequests: f.requestCount() - before,
                        summary: f.summary(),
                    }
                }
            },
        })
    } finally {
        fs.mkdirSync(artifacts, { recursive: true })
        fs.writeFileSync(
            path.join(artifacts, 'memory62026.json'),
            JSON.stringify(
                {
                    boundary:
                        'explicit current local five-handle input and automatic dialogue model; no Unity renderer/physics or whole chapter claim',
                    before,
                    final,
                    local,
                    watches,
                    taskSyncProof,
                    decorativeHandlesNotClicked: [700457, 700458],
                },
                null,
                2,
            ) + '\n',
        )
    }
}
