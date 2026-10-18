import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { planCropHarvest, ensureCropOutcome, cropGrowth, applyWateringUpgrade } from '../src/crop-rewards.js'
import { grantRewards } from '../src/rewards.js'
import { reconcileHomeExperience } from '../src/home-experience.js'

const tables = new Tables(configuration().tables)
const sequence =
    (...values) =>
    (max) =>
        values.length ? values.shift() : max - 1
const state = (level = 1) => ({
    home: {
        level,
        exp: 0,
        builds: [],
        inventory: [],
        shortcuts: [],
        wishlist: [],
        experienceVersion: 1,
        experienceTotal: '0',
        levelRewardedThrough: level,
    },
    homeRevision: 0,
    player: {
        basic_info: { lv: 1, home_lv: 1, gold: 0, diamond: 0 },
        attr_infos: { attrs: [] },
        sbag_infos: { items: [] },
    },
})
const reward = (plan, id) => plan.rewards.find((item) => item.itemid === id)

test('the complete current home-level curve reaches its cap and never pays a level reward twice', () => {
    const s = state(),
        rows = tables.get('home_level'),
        needed = rows.slice(0, -1).reduce((n, row) => n + row.exp, 0)
    grantRewards(tables, s, [{ itemtype: 10, itemid: 1003, itemnum: needed }])
    assert.equal(s.home.level, rows.length)
    assert.equal(s.home.exp, 0)
    assert.equal(s.home.levelRewardedThrough, rows.length)
    const gold = s.player.basic_info.gold,
        coins = s.player.attr_infos.attrs.find((a) => a.attr_id === 103).attr_val
    grantRewards(tables, s, [{ itemtype: 10, itemid: 1003, itemnum: 1 }])
    assert.equal(s.home.level, rows.length)
    assert.equal(s.player.basic_info.gold, gold)
    assert.equal(s.player.attr_infos.attrs.find((a) => a.attr_id === 103).attr_val, coins)
})

test('actual wheat weights choose next-star, same-star seed and ordinary outcomes at exact boundaries', () => {
    const s = state()
    const next = planCropHarvest(tables, s, 1, 1, sequence(1999, 9999))
    assert.equal(next.branch, 'upgrade')
    assert.equal(reward(next, 400102).itemnum, 4)
    assert.equal(reward(next, 310002).itemnum, 1)
    assert.equal(reward(next, 400101), undefined)
    const seed = planCropHarvest(tables, s, 1, 1, sequence(2000, 9999))
    assert.equal(seed.branch, 'seed')
    assert.equal(reward(seed, 310001).itemnum, 1)
    const ordinary = planCropHarvest(tables, s, 1, 1, sequence(4000, 9999))
    assert.equal(ordinary.branch, 'normal')
    assert.equal(reward(ordinary, 310001), undefined)
    assert.equal(reward(ordinary, 1003).itemnum, 16)
    assert.deepEqual(ordinary.drop_ids, [1210011])
})

test('golden drops replace the ordinary crop, use their configured EXP, and fertile yield uses table parameters', () => {
    const golden = planCropHarvest(tables, state(), 1, 1, sequence(9999, 14))
    assert.equal(golden.golden, true)
    assert.equal(reward(golden, 400106).itemnum, 4)
    assert.equal(reward(golden, 400101), undefined)
    assert.equal(reward(golden, 1003).itemnum, 16)
    const miss = planCropHarvest(tables, state(), 1, 1, sequence(9999, 15))
    assert.equal(miss.golden, false)
    const fertile = planCropHarvest(tables, state(), 1, 3, sequence(9999, 9999, 0))
    assert.equal(reward(fertile, 400101).itemnum, 5)
    assert.equal(reward(fertile, 1003).itemnum, 16)
})

test('current technology rows modify growth and extra yield without adding every historical level again', () => {
    const s = state()
    s.home.technology = {
        levels: { 20081: { level: 1 }, 22047: { level: 1 }, 22050: { level: 1 }, 20075: { level: 1 } },
    }
    assert.equal(cropGrowth(tables.find('home_seeds', 1), tables, s).grow, 270)
    assert.equal(cropGrowth(tables.find('home_seeds', 1), tables, s).pre, 540)
    const plan = planCropHarvest(tables, s, 1, 1, sequence(9999, 9999, 0))
    assert.equal(plan.modifiers.extraChance, 1000)
    assert.equal(plan.modifiers.extraCount, 2)
    assert.equal(reward(plan, 400101).itemnum, 6)
})

test('assigned water and harvest talents use the actual ability and crop conditions', () => {
    const s = state(100),
        field = { guid: 100, locate: { block_id: 102, anchor: 0 }, crop_info: { seed_id: 1 } }
    const house = {
        guid: 20,
        status: 1,
        locate: { block_id: 101, anchor: 0 },
        auto_info: { water_pet: 'w', harvest_pet: 'h' },
    }
    s.home.builds = [field, house]
    s.pets = [
        {
            guid: 'w',
            work_status: 5,
            work_build: 20,
            capacity_id: 1002,
            labor_infos: [{ labor_id: 6, labor_grade: 1 }],
            talent_id: [900903001],
        },
        {
            guid: 'h',
            work_status: 5,
            work_build: 20,
            capacity_id: 1003,
            labor_infos: [{ labor_id: 5, labor_grade: 1 }],
            talent_id: [900901001],
        },
    ]
    assert.equal(applyWateringUpgrade(tables, s, field, sequence(4999)), true)
    assert.equal(field.crop_info.seed_id, 2)
    const plan = planCropHarvest(tables, s, 2, 1, sequence(9999, 5014), { build: field })
    assert.equal(plan.modifiers.goldenChance, 5000)
    assert.equal(plan.golden, true)
    s.pets[1].work_status = 0
    const inactive = planCropHarvest(tables, s, 2, 1, sequence(9999, 5014), { build: field })
    assert.equal(inactive.modifiers.goldenChance, 0)
    assert.equal(inactive.golden, false)
})

test('locked upgrades do not bypass home level requirements, including the highest-star empty next-seed fields', () => {
    const locked = planCropHarvest(tables, state(1), 3, 1, sequence(0, 9999))
    assert.equal(locked.branch, 'seed') // first slot is disabled, same-star seed interval begins at zero
    assert.equal(reward(locked, 310004), undefined)
    const stillLocked = planCropHarvest(tables, state(20), 3, 1, sequence(0, 9999))
    assert.notEqual(stillLocked.branch, 'upgrade')
    const open = planCropHarvest(tables, state(26), 3, 1, sequence(0, 9999))
    assert.equal(open.branch, 'upgrade')
    for (const config of tables.get('home_seeds').filter((row) => row.harvestType === 1)) {
        const plan = planCropHarvest(tables, state(100), config.id, 1, (max) => max - 1)
        assert.ok(plan.rewards.length > 0)
        assert.ok(plan.rewards.every((item) => Number.isInteger(item.itemnum) && item.itemnum > 0))
    }
})

test('sealed rewards survive serialization and cannot reroll on login or harvest', () => {
    const s = state(),
        build = { guid: 7, crop_info: { seed_id: 1, field_type: 1, state: 2, state_start_time: 100 } }
    s.home.builds.push(build)
    const plan = ensureCropOutcome(tables, s, build, sequence(2000, 9999))
    const restored = JSON.parse(JSON.stringify(s))
    assert.deepEqual(
        ensureCropOutcome(tables, restored, restored.home.builds[0], () => {
            throw Error('reroll')
        }),
        plan,
    )
    assert.deepEqual(restored.home.builds[0].crop_info.drop_result.drop_ids, [1210011, 1220011])
    assert.equal(cropGrowth(tables.find('home_seeds', 1)).grow, 300)
})

test('home EXP advances the wire level with carry, pays configured level rewards once and repairs old ledgers without retroactive gifts', () => {
    const s = state()
    grantRewards(tables, s, [{ itemtype: 10, itemid: 1003, itemnum: 65 }])
    assert.equal(s.home.level, 2)
    assert.equal(s.home.exp, 5)
    assert.equal(s.player.basic_info.home_lv, 1)
    assert.equal(s.player.attr_infos.attrs.find((a) => a.attr_id === 103).attr_val, '1000')
    assert.equal(s.player.basic_info.gold, 100)
    grantRewards(tables, s, [{ itemtype: 10, itemid: 1003, itemnum: 95 }])
    assert.equal(s.home.level, 3)
    assert.equal(s.home.exp, 0)
    assert.equal(s.player.basic_info.gold, 200)
    const legacy = state()
    delete legacy.home.experienceVersion
    legacy.player.attr_infos.attrs.push({ attr_id: 1003, attr_val: '160' })
    assert.equal(reconcileHomeExperience(tables, legacy), true)
    assert.equal(legacy.home.level, 3)
    assert.equal(legacy.home.exp, 0)
    assert.equal(legacy.player.basic_info.gold, 0)
    assert.equal(reconcileHomeExperience(tables, legacy), false)
})
