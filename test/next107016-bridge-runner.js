import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { runCurrentWingsTracking } from './next107016-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { currentExistingTaskEnemyGroup } from './current-existing-task-enemies.js'
import { currentBridgeRepairInput } from './current-bridge-repair-input.js'

export async function runCurrentWingsBridge({ outputDirectory, afterBridge } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-bridge107016-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, events: [] }
    await runCurrentWingsTracking({
        outputDirectory: directory,
        afterTracking({ f, driver, observer }) {
            const before = f.requestCount()
            assert.equal(before, 5598)
            proof.before = before
            const flow = normalSuccessorFlow(f, driver, {
                npcStoryCompletion(data) {
                    driver.playStory(data.storyId)
                },
                existingEnemiesCompletion(data, context) {
                    currentExistingTaskEnemyGroup(f, driver, data, context, proof.events)
                },
                objectCompletion(data) {
                    currentBridgeRepairInput(f, driver, data, proof.events)
                },
                afterSourceAction(kind, data) {
                    if (kind !== 'TaskWorldUnitStaetChangeData') return false
                    // Current0602e4f5 HandleWorldMapObjState is empty. The
                    // enclosing task action registers/completes locally;no
                    // fabricated world-state RPC or saved-state write.
                    assert.deepEqual(
                        [data.sceneId, data.worldMapId, data.worldMapObjType, data.worldMapObjStateType],
                        [100, 902630, 2, 0],
                    )
                    proof.events.push({ kind: 'current-empty-world-state-action', ...data })
                    return true
                },
            })
            try {
                while (f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id !== 12) {
                    assert(flow.visits.length < 6)
                    flow.step(107016)
                }
                const active = f.state().tasks.find((task) => task.task_id === 107016)
                assert.deepEqual(
                    active.nodes.map((node) => node.node_id),
                    [12],
                )
                assert(active.finish_nodes.includes(11))
                const saved = f.state().worldObjects['100:902630']
                assert(saved.complete && saved.claims.repair.id === 10110)
                f.coldLogin()
                assert.deepEqual(
                    f.state().tasks.find((task) => task.task_id === 107016),
                    active,
                )
                assert.deepEqual(f.state().worldObjects['100:902630'], saved)
                const trace = observer.trace.slice(before)
                assert(!trace.some((row) => row.error))
                assert.equal(trace.filter((row) => row.id === 9139).length, 2)
                const group = proof.events.find((row) => row.kind === 'existing-enemies-all-removed-input')
                assert.equal(group.targets.length, 3)
                assert.equal(
                    trace.filter(
                        (row) => row.id === 9904 && row.request.key === 2519 && row.request.args[0] === 107016014,
                    ).length,
                    1,
                )
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    task: 107016,
                    node: 12,
                    visits: flow.visits,
                    map: f.state().world.map_id,
                    level: f.state().player.basic_info.lv,
                }
                const result = afterBridge?.({ f, driver, observer, flow })
                assert(!result?.then, 'Bridge continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'bridge107016.json'),
                    JSON.stringify(
                        { ...proof, after: f.requestCount(), trace: observer.trace.slice(before), state: f.state() },
                        null,
                        2,
                    ) + '\n',
                )
            }
        },
    })
    return { directory, ...proof }
}
