import test from 'node:test'
import assert from 'node:assert/strict'
import { productionWorkGameFixture } from './production-work-game-fixture.js'
import { cookingRecipe } from '../src/cooking.js'
import { accessoryProductionPlan } from '../src/accessory-production.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'
import { workCompare } from '../src/production-work-fractions.js'

const stock = (s, id) =>
    s.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((sum, row) => sum + row.itemnum, 0)
const wallet = (s, id) => BigInt(s.player.attr_infos.attrs.find((row) => row.attr_id === id)?.attr_val ?? 0)
const eq = (value, expected) => assert.equal(workCompare(value, expected), 0)
function station(f, { guid, buildId, type, satiety }) {
    let selected
    f.edit((s) => {
        s.player.basic_info.lv = 45
        const config = f.tables.find('home_building_production', buildId),
            labor = String(config.laborType).split('|').map(Number),
            sizes = String(config.petSize).split('|').map(Number)
        const pet = s.pets.find(
            (pet) =>
                (!pet.hero_id || pet.hero_id === '0') &&
                !pet.work_status &&
                petModelEligibility(f.tables, pet.config_id).eligible &&
                sizes.includes(f.tables.find('pet_home_talent', pet.config_id)?.sizeType) &&
                pet.labor_infos?.some((entry) => labor.includes(entry.labor_id)),
        )
        assert(pet, 'Real current roster supplies a legal worker for this station')
        selected = pet.guid
        Object.assign(pet, { satiety_val: satiety, talent_id: [] })
        pet.labor_infos = pet.labor_infos.map((entry) =>
            labor.includes(entry.labor_id) ? { ...entry, labor_grade: 1 } : entry,
        )
        s.home.builds.push({
            guid,
            build_id: buildId,
            build_type: type,
            status: 1,
            locate: { block_id: 101, anchor: 6750239, direction: 0 },
            product: [],
        })
        s.home.inventory.push({ build_id: buildId, total_num: 1, used_num: 1, unlock: true })
    })
    f.call('PetStationed', { pet_guid: selected, build_guid: guid, build_type: 1 })
    return selected
}
function forgeFixture(name, satiety) {
    const f = productionWorkGameFixture(name)
    const worker = station(f, { guid: 20, buildId: 20241, type: 8, satiety })
    f.edit((s) => {
        // Existing accessory eligibility fixture: complete configured material
        // records are controlled gates, not claims of new combat victories.
        s.materialDungeonRecords = Object.fromEntries(
            f.tables.get('dungeon_material').map((row) => [
                row.id,
                {
                    material_id: row.id,
                    material_star: 0,
                    success_count: 1,
                    difficulty_id: row.diff,
                    success_time: String(f.now()),
                },
            ]),
        )
        const recipe = f.tables.find('accessory_product', 1)
        grantRewards(
            f.tables,
            s,
            [...parseRewards(recipe.material), ...parseRewards(recipe.locateCost)].map((row) => ({
                ...row,
                itemnum: row.itemnum * 10,
            })),
        )
    })
    f.call('ActivityGet', { u32: 10001 })
    return { f, worker }
}
function assertDebit(before, after, costs, count) {
    for (const row of costs) {
        if (row.itemtype === 3) assert.equal(stock(after, row.itemid), stock(before, row.itemid) - row.itemnum * count)
        else if (row.itemtype === 10)
            assert.equal(wallet(after, row.itemid), wallet(before, row.itemid) - BigInt(row.itemnum * count))
        else assert.fail('Test uses only real supported accessory costs')
    }
}

test('real CookRequest consumes per-serving ingredients once, pauses after two units and resumes only future work before partial/final claims', () => {
    const f = productionWorkGameFixture('work-specialized-cook')
    try {
        const recipe = cookingRecipe(f.tables, 9000301),
            budget = recipe.product.satietyScore
        const worker = station(f, { guid: 18, buildId: 100011, type: 10, satiety: budget * 2 })
        const materials = recipe.requirements.map((row) => ({ item_id: row.choices[0], item_num: row.count }))
        f.edit((s) => {
            for (const id of [22010, 22015, 22020])
                s.home.technology.levels[id] = { level: 1, lastTime: 0, isOpened: true }
            grantRewards(
                f.tables,
                s,
                materials.map((row) => ({ itemtype: 3, itemid: row.item_id, itemnum: row.item_num * 10 })),
            )
        })
        const before = structuredClone(f.state())
        f.call('CookRequest', { build_guid: 18, cook_id: 9000301, cook_count: 3, cook_material: materials })
        let job = f.state().home.productionJobs[18][0]
        assert.equal(job.kind, 'cook')
        assert.equal(job.productId, recipe.product.id)
        const sealed = { costs: structuredClone(job.costs), rewards: structuredClone(job.rewards) }
        for (const row of materials)
            assert.equal(stock(f.state(), row.item_id), stock(before, row.item_id) - row.item_num * 3)
        f.advance(job.seconds * 2)
        job = f.state().home.productionJobs[18][0]
        assert.equal(job.workCompleted, 2)
        assert.equal(job.workPaused, true)
        assert.equal(f.state().pets.find((pet) => pet.guid === worker).satiety_val, 0)
        f.call('ProductFinish', { guid: 18, product_guids: [job.guid] })
        assert.equal(stock(f.state(), 9000301), stock(before, 9000301) + 2)
        f.advance(100)
        assert.equal(f.state().home.productionJobs[18][0].workCompleted, 2)
        f.addFood(1)
        assert.equal(f.state().home.productionJobs[18][0].workCompleted, 2)
        assert.equal(f.canteen().foods.length, 0)
        f.advance(f.state().home.productionJobs[18][0].seconds)
        job = f.state().home.productionJobs[18][0]
        assert.equal(job.workCompleted, 3)
        assert.deepEqual({ costs: job.costs, rewards: job.rewards }, sealed)
        f.call('ProductFinish', { guid: 18, is_all: true })
        assert.equal(stock(f.state(), 9000301), stock(before, 9000301) + 3)
        for (const row of materials)
            assert.equal(stock(f.state(), row.item_id), stock(before, row.item_id) - row.item_num * 3)
        eq(f.state().home.productionWork.stats.spent, budget * 3)
        assert.equal(f.bag(9002901), 99)
    } finally {
        f.close()
    }
})

test('real random ProductOrnamentStart seals its roll, charges one worked unit and refunds only unfinished material costs after pause', () => {
    const { f, worker } = forgeFixture('work-specialized-random-forge', 20)
    try {
        const build = f.state().home.builds.find((row) => row.guid === 20)
        const request = { build_guid: 20, product_id: 1, count: 3 }
        const plan = accessoryProductionPlan(f.tables, f.state(), build, request)
        const before = structuredClone(f.state())
        let rolls = 0
        f.game.rng = () => {
            rolls++
            return 0
        }
        f.call('ProductOrnamentStart', request)
        let jobs = f.state().home.productionJobs[20]
        assert.equal(jobs.length, 3)
        assert(jobs.every((job) => job.kind === 'accessory' && job.count === 1))
        assertDebit(before, f.state(), plan.costs, 3)
        const sealed = jobs.map((job) => ({
            guid: job.guid,
            rewards: structuredClone(job.rewards),
            costs: structuredClone(job.costs),
        }))
        const acceptedRolls = rolls
        assert(acceptedRolls > 0)
        f.advance(120)
        jobs = f.state().home.productionJobs[20]
        assert.equal(jobs[0].workCompleted, 1)
        assert.equal(jobs[1].workCompleted, 0)
        assert.equal(jobs[1].workPaused, true)
        assert.equal(f.state().pets.find((pet) => pet.guid === worker).satiety_val, 0)
        assert.deepEqual(
            jobs.map((job) => ({ guid: job.guid, rewards: job.rewards, costs: job.costs })),
            sealed,
        )
        assert.equal(rolls, acceptedRolls, 'work/pause does not roll the accepted output again')
        const expected = f.tables.find('accessory_customed', sealed[0].rewards[0].itemid)
        f.call('ProductFinish', { guid: 20, product_guids: [sealed[0].guid] })
        assert.equal(f.state().ornaments.length, 1)
        assert.equal(f.state().ornaments[0].id, expected.accessoryId)
        f.call('ProductCancel', { guid: 20, is_all: true })
        assertDebit(before, f.state(), plan.costs, 1)
        eq(f.state().home.productionWork.stats.spent, 20)
        assert.equal(f.state().home.productionJobs[20].length, 0)
        assert.equal(f.state().pets.find((pet) => pet.guid === worker).work_pause, false)
    } finally {
        f.close()
    }
})

test('real designated forge pays the locate coupon once, takes one dish only after pause and6554 grants its sealed target without reroll', () => {
    const { f, worker } = forgeFixture('work-specialized-designated-forge', 0)
    try {
        const request = { build_guid: 20, product_id: 1, count: 1, designated_item_id: 50018 }
        const plan = accessoryProductionPlan(
            f.tables,
            f.state(),
            f.state().home.builds.find((row) => row.guid === 20),
            request,
        )
        const before = structuredClone(f.state())
        let rolls = 0
        f.game.rng = () => {
            rolls++
            return 0
        }
        f.call('ProductOrnamentStart', request)
        let job = f.state().home.productionJobs[20][0]
        assert.equal(job.designatedItemId, 50018)
        assert.equal(job.workPaused, true)
        assert.equal(job.workCompleted, 0)
        assertDebit(before, f.state(), plan.costs, 1)
        assertDebit(before, f.state(), plan.locateCosts, 1)
        const sealed = {
            rewards: structuredClone(job.rewards),
            costs: structuredClone(job.costs),
            designateCosts: structuredClone(job.designateCosts),
        }
        f.advance(100)
        assert.equal(f.state().home.productionJobs[20][0].workCompleted, 0)
        eq(f.state().home.productionWork.stats.spent, 0)
        f.addFood(1)
        assert.equal(f.state().home.productionJobs[20][0].workCompleted, 0)
        assert.equal(f.canteen().foods.length, 0)
        f.advance(120)
        job = f.state().home.productionJobs[20][0]
        assert.equal(job.workCompleted, 1)
        assert.deepEqual({ rewards: job.rewards, costs: job.costs, designateCosts: job.designateCosts }, sealed)
        assert.equal(rolls, 0, 'a designated accepted leaf is not redrawn by work/feeding')
        f.call('GetAllBuildReward', { build_guid: [20] })
        const custom = f.tables.find('accessory_customed', 50018)
        assert.equal(f.state().ornaments.length, 1)
        assert.equal(f.state().ornaments[0].id, custom.accessoryId)
        assert.equal(f.state().ornaments[0].grade, custom.grade)
        assertDebit(before, f.state(), plan.locateCosts, 1)
        assert.equal(f.state().pets.find((pet) => pet.guid === worker).satiety_val, 5)
        eq(f.state().home.productionWork.stats.spent, 20)
        assert.equal(f.bag(9002901), 99)
        f.call('GetAllBuildReward', { build_guid: [20] })
        assert.equal(f.state().ornaments.length, 1)
    } finally {
        f.close()
    }
})
