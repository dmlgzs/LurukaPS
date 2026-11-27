import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentShadowChapter } from './next106015-main-runner.js'
import { currentEntrustInputModel, totalExperience } from './current-entrust-input-model.js'
import { parseRewards } from '../src/rewards.js'
import { TaskGraphs, taskSnapshot } from '../src/tasks.js'

// Genuine full normal106015 prerequisite. Current material entry, HP inputs,
// paid claim and exit earn the next level gate; no direct level/task writes.
export async function reachCurrent106016({ outputDirectory, afterUnlock } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-reach106016-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, runs: [] }
    await runCurrentShadowChapter({
        outputDirectory: directory,
        afterChapter({ f, driver, observer }) {
            const beforeRequests = f.requestCount()
            const config = f.tables.find('task', 106016)
            assert.equal(config.unlockcondition, '2007#106015|2004#20')
            const target = Number(config.unlockcondition.match(/(?:^|\|)2004#(\d+)(?:\||$)/)[1])
            const required = f.tables
                .get('player_level')
                .filter((row) => row.id < target)
                .reduce((sum, row) => sum + row.exp, 0)
            const materialXp = parseRewards(f.tables.find('dungeon_material', 10101).rewardShow)
                .filter((row) => row.itemtype === 10 && row.itemid === 10)
                .reduce((sum, row) => sum + row.itemnum, 0)
            assert.equal(materialXp, 300)
            const { finish, stamina } = currentEntrustInputModel(f, driver)
            const beforeExperience = totalExperience(f.tables, f.state())
            const beforeStamina = stamina()
            const needed = required - beforeExperience
            const bound = Math.ceil(needed / materialXp)
            assert(needed > 0 && bound > 0 && beforeStamina >= BigInt(bound * 30))
            assert.equal(beforeRequests, 3322)
            assert.equal(f.state().taskRecords.find((row) => row.task_id === 106015).count, 1)
            assert.equal(taskSnapshot(f.tables, f.state()).next_main_id, 106016)
            assert(!f.state().tasks.some((row) => row.task_id === 106016))
            proof.before = {
                requests: beforeRequests,
                level: f.state().player.basic_info.lv,
                exp: f.state().player.basic_info.exp,
                stamina: String(beforeStamina),
                requiredLevel: target,
                neededExperience: needed,
                expectedRuns: bound,
            }
            try {
                while (f.state().player.basic_info.lv < target) {
                    assert(proof.runs.length < bound)
                    assert(!f.state().tasks.some((row) => row.task_id === 106016))
                    assert.equal(taskSnapshot(f.tables, f.state()).next_main_id, 106016)
                    proof.runs.push(finish(10101, 'material', true))
                }
                assert.equal(proof.runs.length, bound)
                assert.equal(totalExperience(f.tables, f.state()), beforeExperience + materialXp * bound)
                assert.equal(stamina(), beforeStamina - BigInt(30 * bound))
                const graph = new TaskGraphs(f.tables).get(106016)
                const entry = graph.nodes.get(graph.start).nextNodeIdList
                assert.deepEqual(entry, [15])
                const active = f.state().tasks.find((row) => row.task_id === 106016)
                assert(active)
                assert.deepEqual(
                    active.nodes.map((row) => row.node_id),
                    entry,
                )
                assert.deepEqual(active.nodes[0].node_values, [0])
                assert.equal(active.nodes[0].client_before, false)
                assert.equal(taskSnapshot(f.tables, f.state()).next_main_id, 0)
                const earned = f.state()
                f.coldLogin()
                assert.deepEqual(f.state().player.basic_info, earned.player.basic_info)
                assert.deepEqual(
                    f.state().tasks.find((row) => row.task_id === 106016),
                    active,
                )
                assert.equal(f.state().taskRecords.find((row) => row.task_id === 106015).count, 1)
                assert.equal(stamina(), beforeStamina - BigInt(30 * bound))
                assert(!f.state().taskRecords.some((row) => row.task_id === 106016 && row.count > 0))
                const delta = observer.trace.slice(beforeRequests)
                assert.equal(delta.filter((row) => row.error).length, 0)
                assert.equal(delta.filter((row) => row.id === 9974).length, bound)
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - beforeRequests,
                    level: f.state().player.basic_info.lv,
                    exp: f.state().player.basic_info.exp,
                    stamina: String(stamina()),
                    paidRuns: proof.runs.length,
                    earnedExperience: materialXp * bound,
                    spentStamina: 30 * bound,
                    task: 106016,
                    node: active.nodes[0].node_id,
                    instanceIds: proof.runs.map((run) => run.instance),
                }
                assert.equal(new Set(proof.final.instanceIds).size, bound)
                const result = afterUnlock?.({ f, driver, observer })
                assert(!result?.then, 'Unlock continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'reach106016.json'),
                    JSON.stringify(
                        { ...proof, trace: observer.trace.slice(beforeRequests), state: f.state() },
                        null,
                        2,
                    ) + '\n',
                )
            }
        },
    })
    return { directory, ...proof }
}
