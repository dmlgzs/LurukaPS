import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentFoodMeal } from './next106016-meal-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { currentTaskGuideInput } from './current-task-guide-input.js'
import { taskSnapshot } from '../src/tasks.js'

// Current-source local NPC readiness/arrival/contact inputs,not a Unity
// behaviour-tree,NavMesh,AOI,rendering or animation execution claim.
export async function runCurrentFoodChapter({ outputDirectory, afterChapter } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-food-chapter106016-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, guides: [] }
    await runCurrentFoodMeal({
        outputDirectory: directory,
        afterMeal({ f, driver, observer }) {
            const before = f.requestCount()
            assert.equal(before, 5515)
            proof.before = before
            const flow = normalSuccessorFlow(f, driver, {
                npcStoryCompletion: (data) => driver.playStory(data.storyId),
                signalCompletion(data, { taskId, node }) {
                    assert.equal(taskId, 106016)
                    assert.equal(node.id, 35)
                    const guide = currentTaskGuideInput(f.tables, driver.graphs.get(taskId), node.id)
                    assert.equal(f.state().world.map_id, guide.source.map)
                    assert.equal(guide.takeSignal(), null)
                    for (const [index, point] of guide.points.entries()) {
                        // Successful actor arrival is local input. The player's
                        // actual normal movement RPC follows each source point.
                        guide.arrive(index, point)
                        driver.move({
                            x: Math.round(point.x * 100),
                            y: Math.round(point.y * 100),
                            z: Math.round(point.z * 100),
                        })
                        f.advanceMs(1000) // explicit input schedule,not a recovered official travel time
                        const pos = f.state().world.pos
                        guide.playerAt({ x: pos.x / 100, y: pos.y / 100, z: pos.z / 100 })
                        if (index < guide.points.length - 1) assert.equal(guide.takeSignal(), null)
                    }
                    const event = guide.takeSignal()
                    assert.deepEqual(event, { event: 2008, signalType: data.signalType, taskId })
                    assert.equal(guide.takeSignal(), null)
                    proof.guides.push({ source: guide.source, event, state: guide.snapshot() })
                },
            })
            const prior = f.state()
            try {
                while (f.state().tasks.some((task) => task.task_id === 106016)) {
                    assert(flow.visits.length < 10)
                    flow.step(106016)
                }
                const completed = f.state()
                assert.equal(completed.taskRecords.find((task) => task.task_id === 106016).count, 1)
                assert.equal(completed.player.basic_info.lv, 20)
                assert.equal(completed.player.basic_info.exp, prior.player.basic_info.exp + 1200)
                const next = completed.tasks.find((task) => task.task_id === 107016)
                assert(next, 'Current107016 successor must be admitted through its actual table prerequisite')
                assert.equal(f.tables.find('task', 107016).unlockcondition, '2007#106016|2004#20')
                assert.equal(taskSnapshot(f.tables, completed).next_main_id, 0)
                const itemCount = (state) =>
                    state.player.sbag_infos.items
                        .filter((item) => item.itemid === 1100026)
                        .reduce((sum, item) => sum + item.itemnum, 0)
                assert.equal(itemCount(completed), itemCount(prior) + 1)
                f.coldLogin()
                assert.equal(f.state().taskRecords.find((task) => task.task_id === 106016).count, 1)
                assert(!f.state().tasks.some((task) => task.task_id === 106016))
                assert.deepEqual(
                    f.state().tasks.find((task) => task.task_id === 107016),
                    next,
                )
                assert.equal(itemCount(f.state()), itemCount(completed))
                const trace = observer.trace.slice(before)
                assert.equal(trace.filter((row) => row.error).length, 0)
                assert.equal(
                    trace.filter(
                        (row) =>
                            row.id === 9904 &&
                            row.request.key === 2519 &&
                            row.request.args[1] === 106016 &&
                            row.request.args[2] === 35,
                    ).length,
                    1,
                )
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    completedTask: 106016,
                    count: 1,
                    nextTask: 107016,
                    nextNodes: next.nodes.map((node) => node.node_id),
                    level: f.state().player.basic_info.lv,
                    exp: f.state().player.basic_info.exp,
                    visits: flow.visits.map((row) => row.nodeId),
                    map: f.state().world.map_id,
                }
                const result = afterChapter?.({ f, driver, observer, flow })
                assert(!result?.then, 'Chapter continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'chapter106016.json'),
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
