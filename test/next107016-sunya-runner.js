import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { runCurrentWingsBeforePlayables } from './next107016-before-playables-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { runCurrentSunya } from './current-sunya-producer.js'

export async function runCurrentWingsSunya({ outputDirectory, afterSunya } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-sunya62043-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, events: [] }
    await runCurrentWingsBeforePlayables({
        outputDirectory: directory,
        afterApproach({ f, driver, observer }) {
            const before = f.requestCount()
            assert.equal(before, 5694)
            proof.before = before
            const flow = normalSuccessorFlow(f, driver, {
                playableIsFinishCompletion(data, context) {
                    runCurrentSunya(f, driver, data, context, proof.events)
                },
            })
            try {
                flow.step(107016)
                const state = f.state(),
                    task = state.tasks.find((task) => task.task_id === 107016)
                assert.deepEqual(
                    task.nodes.map((node) => [node.node_id, node.node_values]),
                    [[22, [0]]],
                )
                assert.equal(state.playableFinishes[62043].play_id, 62043)
                assert.equal(state.playableFinishes?.[62031], undefined)
                f.coldLogin()
                assert.deepEqual(
                    f.state().tasks.find((task) => task.task_id === 107016),
                    task,
                )
                assert.deepEqual(f.state().playableFinishes[62043], state.playableFinishes[62043])
                const trace = observer.trace.slice(before)
                assert(!trace.some((row) => row.error))
                assert.equal(trace.filter((row) => row.id === 9403 && row.request.u32 === 62043).length, 1)
                assert.deepEqual(
                    trace
                        .filter((row) => row.id === 9406 && row.request.playId === 62043)
                        .map((row) => row.request.finish_step),
                    [4, 10, 10],
                )
                assert.equal(trace.filter((row) => row.id === 9404 && row.request.playId === 62043).length, 2)
                assert.equal(
                    trace.filter((row) => row.id === 9904 && row.request.key === 2519 && row.request.args[0] === 62043)
                        .length,
                    1,
                )
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    task: 107016,
                    node: 22,
                    map: f.state().world.map_id,
                    visits: flow.visits,
                }
                const result = afterSunya?.({ f, driver, observer, flow })
                assert(!result?.then, 'Sunya continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'sunya62043.json'),
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
