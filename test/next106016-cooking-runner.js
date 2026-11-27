import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentFoodApproach } from './next106016-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { guidedConditionValue } from '../src/guided-conditions.js'

// Actual normal5419 account, current cookbook config1003 and per-serving
// ingredients. A successful timer is a local input,not Unity execution.
export async function runCurrentFoodCooking({ outputDirectory, afterCooking } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-food-cooking106016-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, cooking: [] }
    await runCurrentFoodApproach({
        outputDirectory: directory,
        afterApproach({ f, driver, observer }) {
            const before = f.requestCount()
            assert.equal(before, 5419)
            proof.before = before
            const stock = (id) =>
                f
                    .state()
                    .player.sbag_infos.items.filter((item) => item.itemid === id)
                    .reduce((sum, item) => sum + item.itemnum, 0)
            const flow = normalSuccessorFlow(f, driver, {
                npcStoryCompletion: (data) => driver.playStory(data.storyId),
                guidedCompletion(condition, { node }) {
                    const id = condition.__type_TaskConditionBaseData.__type_TaskCondGuidedAchievementsData.achievId
                    assert.equal(node.id, 26)
                    assert.equal(id, 10049)
                    assert.equal(f.tables.find('task_condition', id).condition, '12041|9000301|1')
                    assert.equal(guidedConditionValue(id, f.state()), 0)
                    const recipe = f.tables.find('products', 9100301)
                    assert.equal(recipe.unlockCondition, '11012#22010#1')
                    const group = f.tables.get('products_multi_quality').find((row) =>
                        String(row.productId)
                            .split('|')
                            .includes('1#' + recipe.id),
                    )
                    assert.equal(group.id, 1003)
                    assert.equal(group.calculateNeedMaterial, '3#6')
                    assert.equal(group.uncalculateNeedMaterial, '')
                    const ingredient = f.tables
                        .find('food_material_group', 3)
                        .includeItems.split('|')
                        .map((pair) => pair.split('#').map(Number))
                        .find(([, grade]) => grade === 1)[0]
                    assert.equal(ingredient, 400301)
                    const station = f
                        .state()
                        .home.builds.find(
                            (build) =>
                                build.locate &&
                                String(recipe.group)
                                    .split('|')
                                    .map(Number)
                                    .includes(f.tables.find('home_building_production', build.build_id)?.groupId),
                        )
                    assert(station)
                    assert.equal(f.state().home.technology.levels[22010].level, 1)
                    const oldJobs = new Set(
                        Object.values(f.state().home.productionJobs ?? {})
                            .flat()
                            .map((job) => job.guid),
                    )
                    const beforeFood = stock(9000301),
                        beforeCorn = stock(ingredient)
                    const request = {
                        build_guid: station.guid,
                        cook_id: group.id,
                        cook_count: 1,
                        cook_material: [{ item_id: ingredient, item_num: 6 }],
                    }
                    driver.call('CookRequest', request)
                    assert.equal(stock(ingredient), beforeCorn - 6)
                    assert.equal(stock(9000301), beforeFood)
                    assert.equal(guidedConditionValue(id, f.state()), 0)
                    const job = Object.values(f.state().home.productionJobs)
                        .flat()
                        .find((row) => !oldJobs.has(row.guid) && row.kind === 'cook')
                    assert(job)
                    assert.equal(job.productId, recipe.id)
                    assert.equal(job.seconds, 10)
                    assert.equal(job.count, 1)
                    assert.deepEqual(job.cookingUnits, [
                        { grade: 1, productId: recipe.id, rewards: [{ itemtype: 3, itemid: 9000301, itemnum: 1 }] },
                    ])
                    f.advanceMs(Math.max(0, (job.start + job.count * job.seconds) * 1000 - f.nowMs()) + 1)
                    assert.equal(guidedConditionValue(id, f.state()), 0, 'Ready but unclaimed food is not bag stock')
                    const packets = driver.call('ProductFinish', { guid: station.guid, is_all: true })
                    const claim = driver.reply('ProductFinish', packets)
                    assert(
                        claim.reward.rewards.some(
                            (row) => row.itemtype === 3 && row.itemid === 9000301 && row.itemnum === 1,
                        ),
                    )
                    assert.equal(stock(9000301), beforeFood + 1)
                    assert.equal(guidedConditionValue(id, f.state()), 1)
                    assert(
                        packets.some(
                            (packet) =>
                                packet.id === 9853 &&
                                f.protocol
                                    .decode(f.protocol.byId.get(9853).rsp, packet.payload)
                                    .tasks?.some(
                                        (task) =>
                                            task.task_id === 106016 &&
                                            task.nodes.some(
                                                (entry) => entry.node_id === 26 && entry.node_values[0] === 1,
                                            ),
                                    ),
                        ),
                    )
                    proof.cooking.push({
                        request,
                        job,
                        output: 9000301,
                        ingredientBefore: beforeCorn,
                        ingredientAfter: stock(ingredient),
                        stockBefore: beforeFood,
                        stockAfter: stock(9000301),
                    })
                },
            })
            try {
                while (f.state().tasks.find((task) => task.task_id === 106016).nodes[0].node_id !== 31) {
                    assert(flow.visits.length < 15)
                    flow.step(106016)
                }
                const earned = f.state()
                const active = earned.tasks.find((task) => task.task_id === 106016)
                assert.deepEqual(
                    active.nodes.map((node) => [node.node_id, node.node_values]),
                    [[31, [0]]],
                )
                assert.equal(guidedConditionValue(10020, earned), 0)
                assert.equal(earned.world.map_id, 701)
                assert.equal(f.tables.find('products', 9102301).unlockCondition, '12045#106016#30')
                assert(active.finish_nodes.includes(30), 'Recipe unlocked through actual task progression')
                f.coldLogin()
                assert.deepEqual(
                    f.state().tasks.find((task) => task.task_id === 106016),
                    active,
                )
                assert.equal(stock(9000301), 1)
                assert.equal(guidedConditionValue(10020, f.state()), 0)
                assert(!f.state().taskRecords.some((task) => task.task_id === 106016 && task.count > 0))
                assert.equal(observer.trace.slice(before).filter((row) => row.error).length, 0)
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    task: 106016,
                    node: 31,
                    pendingGuided: 10020,
                    map: 701,
                    level: f.state().player.basic_info.lv,
                    exp: f.state().player.basic_info.exp,
                    visits: flow.visits.map((row) => row.nodeId),
                }
                const result = afterCooking?.({ f, driver, observer, flow })
                assert(!result?.then, 'Cooking continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'food-cooking106016.json'),
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
