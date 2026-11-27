import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentFoodCooking } from './next106016-cooking-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { guidedConditionValue } from '../src/guided-conditions.js'

// Genuine5463 account. Existing farmland and actual paid seeds produce the
// ingredients. A legal midpoint RNG is explicit test input for normal crops;
// no service probability, inventory, node or saved crop plan is edited.
export async function runCurrentFoodMeal({ outputDirectory, afterMeal } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-food-meal106016-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = { before: null, final: null, farm: [], rolls: [], cooking: [] }
    await runCurrentFoodCooking({
        outputDirectory: directory,
        afterCooking({ f, driver, observer }) {
            const before = f.requestCount()
            assert.equal(before, 5463)
            proof.before = before
            const stock = (id) =>
                f
                    .state()
                    .player.sbag_infos.items.filter((item) => item.itemid === id)
                    .reduce((sum, item) => sum + item.itemnum, 0)
            const points = () => BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 103).attr_val)
            const growIngredients = () => {
                assert.equal(f.state().world.map_id, 701)
                const seeds = [
                    { slot: 2010103, item: 310016, product: 400201 },
                    { slot: 2010107, item: 310026, product: 400501 },
                    { slot: 2010109, item: 310021, product: 400701 },
                ]
                const beforePoints = points(),
                    beforeSeeds = seeds.map((seed) => stock(seed.item))
                driver.call('ShopInfoReq', { shop_id: 200001 })
                driver.call('ShopBuyItems', {
                    shop_id: 200001,
                    items: seeds.map((seed) => ({ slot_id: seed.slot, goods_id: seed.slot, times: 1 })),
                })
                assert.equal(points(), beforePoints - 180n)
                for (const [index, seed] of seeds.entries()) assert.equal(stock(seed.item), beforeSeeds[index] + 10)
                proof.farm.push({
                    kind: 'paid-seeds',
                    shop: 200001,
                    seeds,
                    pointsBefore: String(beforePoints),
                    pointsAfter: String(points()),
                })
                const fields = f
                    .state()
                    .home.builds.filter((build) => build.build_id === 20161 && build.locate)
                    .toSorted((a, b) => a.guid - b.guid)
                assert.equal(fields.length, 4)
                assert(
                    fields.every(
                        (build) =>
                            build.crop_info.seed_id &&
                            build.crop_info.state === 2 &&
                            f.nowMs() >= 1000 * (build.crop_info.state_finish_time + build.crop_info.pre_cost_time),
                    ),
                )
                const old = driver.reply(
                    'FieldHarvestList',
                    driver.call('FieldHarvestList', { build_guids: fields.map((field) => field.guid), is_pet: false }),
                )
                assert.equal(old.results.length, 4)
                assert(
                    fields.every(
                        (field) => !f.state().home.builds.find((build) => build.guid === field.guid).crop_info.seed_id,
                    ),
                )
                proof.farm.push({
                    kind: 'claim-prior-crops',
                    fields: fields.map((field) => field.guid),
                    results: old.results,
                })
                const oldRng = f.game.rng
                f.game.rng = (minOrMax, maximum) => {
                    const min = maximum === undefined ? 0 : minOrMax
                    const max = maximum === undefined ? minOrMax : maximum
                    assert(Number.isSafeInteger(min) && Number.isSafeInteger(max) && max > min)
                    const value = min + Math.floor((max - min) / 2)
                    proof.rolls.push({ min, max, value })
                    return value
                }
                const plantBatch = (plantings) => {
                    const beforeStock = seeds.map((seed) => stock(seed.item))
                    driver.call('FieldPlant', {
                        plant_info: plantings.map(({ field, seed }) => ({
                            build_guid: field.guid,
                            seed_id: seed.item,
                        })),
                        is_pet: false,
                    })
                    for (const [index, seed] of seeds.entries())
                        assert.equal(
                            stock(seed.item),
                            beforeStock[index] -
                                plantings.filter((planting) => planting.seed.item === seed.item).length,
                        )
                    for (const { field } of plantings) {
                        driver.call('FieldWater', { build_guid: field.guid, is_pet: false })
                        driver.call('WaterFinish', { build_guid: field.guid, is_pet: false })
                    }
                    const plans = plantings.map(({ field }) => f.state().home.cropOutcomes[field.guid])
                    assert(plans.every((plan) => plan.branch === 'normal' && !plan.golden))
                    const finish = Math.max(
                        ...plantings.map(({ field }) => {
                            const crop = f.state().home.builds.find((build) => build.guid === field.guid).crop_info
                            return crop.state_finish_time + crop.pre_cost_time
                        }),
                    )
                    f.advanceMs(Math.max(0, finish * 1000 - f.nowMs()) + 1)
                    const result = driver.reply(
                        'FieldHarvestList',
                        driver.call('FieldHarvestList', {
                            build_guids: plantings.map(({ field }) => field.guid),
                            is_pet: false,
                        }),
                    )
                    assert.equal(result.results.length, plantings.length)
                    proof.farm.push({
                        kind: 'plant-water-claim',
                        plantings: plantings.map(({ field, seed }) => ({
                            field: field.guid,
                            seed: seed.item,
                            product: seed.product,
                        })),
                        finish,
                        plans,
                        results: result.results,
                    })
                }
                try {
                    plantBatch(fields.map((field, index) => ({ field, seed: seeds[index < 2 ? 0 : 1] })))
                    plantBatch(fields.slice(0, 2).map((field) => ({ field, seed: seeds[2] })))
                } finally {
                    f.game.rng = oldRng
                }
                for (const seed of seeds) assert(stock(seed.product) >= 5)
            }
            const flow = normalSuccessorFlow(f, driver, {
                npcStoryCompletion: (data) => driver.playStory(data.storyId),
                guidedCompletion(condition, { node }) {
                    const id = condition.__type_TaskConditionBaseData.__type_TaskCondGuidedAchievementsData.achievId
                    assert.equal(node.id, 31)
                    assert.equal(id, 10020)
                    assert.equal(f.tables.find('task_condition', id).condition, '12041|9004201|5')
                    assert.equal(guidedConditionValue(id, f.state()), 0)
                    growIngredients()
                    const recipe = f.tables.find('products', 9102301)
                    assert.equal(recipe.unlockCondition, '12045#106016#30')
                    assert(
                        f
                            .state()
                            .tasks.find((task) => task.task_id === 106016)
                            .finish_nodes.includes(30),
                    )
                    const group = f.tables.get('products_multi_quality').find((row) =>
                        String(row.productId)
                            .split('|')
                            .includes('1#' + recipe.id),
                    )
                    assert.equal(group.id, 1038)
                    assert.equal(group.calculateNeedMaterial, '8#1|10#1|9#1')
                    const selected = group.calculateNeedMaterial.split('|').map((token) => {
                        const [id, count] = token.split('#').map(Number)
                        const item = f.tables
                            .find('food_material_group', id)
                            .includeItems.split('|')
                            .map((entry) => entry.split('#').map(Number))
                            .find(([, grade]) => grade === 1)
                        assert(item)
                        return { item_id: item[0], item_num: count }
                    })
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
                    const beforeFood = stock(9004201),
                        beforeMaterials = selected.map((item) => stock(item.item_id))
                    const oldJobs = new Set(
                        Object.values(f.state().home.productionJobs ?? {})
                            .flat()
                            .map((job) => job.guid),
                    )
                    const request = {
                        build_guid: station.guid,
                        cook_id: group.id,
                        cook_count: 5,
                        cook_material: selected,
                    }
                    driver.call('CookRequest', request)
                    for (const [index, item] of selected.entries())
                        assert.equal(stock(item.item_id), beforeMaterials[index] - item.item_num * 5)
                    const job = Object.values(f.state().home.productionJobs)
                        .flat()
                        .find((entry) => !oldJobs.has(entry.guid) && entry.kind === 'cook')
                    assert(job && job.count === 5 && job.productId === recipe.id)
                    assert(job.cookingUnits.every((unit) => unit.grade === 1 && unit.rewards[0].itemid === 9004201))
                    assert.equal(guidedConditionValue(id, f.state()), 0)
                    f.advanceMs(Math.max(0, (job.start + job.count * job.seconds) * 1000 - f.nowMs()) + 1)
                    assert.equal(guidedConditionValue(id, f.state()), 0)
                    const packets = driver.call('ProductFinish', { guid: station.guid, is_all: true })
                    assert.equal(stock(9004201), beforeFood + 5)
                    assert.equal(guidedConditionValue(id, f.state()), 5)
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
                                                (entry) => entry.node_id === 31 && entry.node_values[0] === 5,
                                            ),
                                    ),
                        ),
                    )
                    proof.cooking.push({
                        request,
                        job,
                        beforeMaterials,
                        afterMaterials: selected.map((item) => stock(item.item_id)),
                        beforeFood,
                        afterFood: stock(9004201),
                    })
                },
            })
            try {
                while (f.state().tasks.find((task) => task.task_id === 106016).nodes[0].node_id !== 35) {
                    assert(flow.visits.length < 10)
                    flow.step(106016)
                }
                const active = f.state().tasks.find((task) => task.task_id === 106016)
                assert.deepEqual(
                    active.nodes.map((node) => [node.node_id, node.node_values]),
                    [[35, [0]]],
                )
                const source = driver.graphs.get(106016).nodes.get(35).__type_TaskConditionNodeData.conditionList[0]
                assert.equal(source.contentType, 16100)
                assert.equal(source.__type_TaskConditionBaseData.__type_TaskCondSignalReceiverData.signalType, 0)
                assert(!f.state().taskEvents['106016:1:35:0'])
                f.coldLogin()
                assert.deepEqual(
                    f.state().tasks.find((task) => task.task_id === 106016),
                    active,
                )
                assert.equal(stock(9004201), 5)
                assert(!f.state().taskRecords.some((task) => task.task_id === 106016 && task.count > 0))
                assert.equal(observer.trace.slice(before).filter((row) => row.error).length, 0)
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    task: 106016,
                    node: 35,
                    pendingSignal: 0,
                    level: f.state().player.basic_info.lv,
                    exp: f.state().player.basic_info.exp,
                    visits: flow.visits.map((row) => row.nodeId),
                    food: stock(9004201),
                    map: f.state().world.map_id,
                }
                const result = afterMeal?.({ f, driver, observer, flow })
                assert(!result?.then, 'Meal continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'food-meal106016.json'),
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
