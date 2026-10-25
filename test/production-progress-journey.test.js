import test from 'node:test'
import assert from 'node:assert/strict'
import { productionProgressFixture } from './production-progress-fixture.js'
import { journeyModel, journeyValue } from '../src/journey.js'
import { productionProgressRule, productionProgressValue, recordProductionOutput } from '../src/production-progress.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

function recipeFor(f, row) {
    const [, buildingType, resource, id] = row.tokens
    return f.tables.get('products').find((recipe) => {
        if (
            recipe.notReleased ||
            recipe.isNeedPet ||
            !parseRewards(recipe.rewardId).some((r) => r.itemtype === resource && (!id || r.itemid === id))
        )
            return false
        const groups = String(recipe.group).split('|').map(Number)
        return f.tables
            .get('home_building_production')
            .some(
                (station) =>
                    groups.includes(station.groupId) &&
                    f.tables
                        .get('home_building_group')
                        .some(
                            (group) =>
                                group.groupId === f.tables.find('home_building', station.id)?.groupId &&
                                group.type === buildingType,
                        ),
            )
    })
}
function forge(f, id = 1) {
    const recipe = f.tables.find('accessory_product', id)
    f.edit((s) => {
        s.materialDungeonRecords ??= {}
        s.materialDungeonRecords[recipe.dungeonId] = {
            material_id: recipe.dungeonId,
            material_star: 0,
            success_count: 1,
        }
        if (!s.home.builds.some((b) => b.guid === 900))
            s.home.builds.push({
                guid: 900,
                build_id: 20241,
                build_type: 8,
                status: 1,
                locate: { block_id: 101, anchor: 6750239, direction: 0 },
            })
        grantRewards(f.tables, s, parseRewards(recipe.material))
    })
    f.game.rng = () => 0
    f.call('ProductOrnamentStart', { build_guid: 900, product_id: id, count: 1 })
    return { guid: 900, job: f.state().home.productionJobs[900].at(-1) }
}

test('full current12018 journey family compiles from station outputs, without requiring duplicate guided rows', () => {
    const f = productionProgressFixture('journey-production-catalogue')
    try {
        const model = journeyModel(f.tables),
            rows = model.referencedTargets.filter((row) => row.tokens[0] === 12018)
        assert.equal(rows.length, 15)
        assert(rows.every((row) => row.supported))
        assert.equal(model.targets.filter((row) => row.supported).length, 134)
        assert.equal(model.referencedTargets.filter((row) => row.supported).length, 118)
        assert.equal(model.referencedTargets.filter((row) => !row.supported).length, 177)
        assert.equal(model.owner.has(6042025), false)
        assert.equal(model.byTarget.get(6042025).supported, true)
        assert.equal(rows.filter((row) => row.tokens[3] === 0).length, 3)
        f.edit((s) => {
            s.home.craftCounts = Object.fromEntries(f.tables.get('products').map((row) => [row.id, 9999]))
            s.cookCounts = { 9006301: 99, 9006401: 99 }
        })
        f.reload()
        assert(rows.every((row) => journeyValue(f.tables, f.state(), row) === 0))
    } finally {
        f.store.close()
    }
})

test('all15 referenced goals observe real ProductStart, CookRequest or new forge output claims', () => {
    const f = productionProgressFixture('journey-production-all')
    try {
        const model = journeyModel(f.tables),
            rows = model.referencedTargets.filter((row) => row.tokens[0] === 12018)
        f.edit((s) => {
            if (s.reputations?.[10]) s.reputations[10].level = 3
        })
        for (const row of rows) {
            if (row.tokens[1] === 8) {
                const accepted = forge(f)
                assert.equal(f.state().journey.targets[row.id]?.value ?? 0, 0)
                f.advance(accepted.job.seconds)
                f.finish(accepted)
            } else {
                const recipe = recipeFor(f, row)
                assert(recipe, String(row.id))
                const packets = f.produce(recipe.id)
                assert(
                    packets.some((packet) => packet.id === 11880),
                    String(row.id),
                )
            }
            assert(journeyValue(f.tables, f.state(), row) >= 1, String(row.id))
            assert.equal(f.state().journey.targets[row.id]?.complete, true, String(row.id))
        }
        assert(rows.every((row) => f.state().journey.targets[row.id]?.complete))
        assert(!f.state().journey.targets[6042025]?.claimed)
    } finally {
        f.store.close()
    }
})

test('element wildcard excludes type12 output and accepts real type2 furnace while obsolete group13 is not forge authority', () => {
    const f = productionProgressFixture('journey-production-building-types')
    try {
        const model = journeyModel(f.tables),
            row = model.byTarget.get(2030024)
        const recipe = f.tables.find('products', 160001)
        const config = f.tables
            .get('home_building_production')
            .find((r) => String(recipe.group).split('|').map(Number).includes(r.groupId))
        assert(config)
        const building = f.tables.find('home_building', config.id)
        const type = f.tables.get('home_building_group').find((r) => r.groupId === building.groupId).type
        assert.equal(type, 12)
        // Pure producer-unit negative: not a claim that malformed legacy recipe160001 can be started today.
        f.edit((s) =>
            recordProductionOutput(
                f.tables,
                s,
                { build_id: config.id, build_type: type },
                parseRewards(recipe.rewardId),
            ),
        )
        assert.equal(journeyValue(f.tables, f.state(), row), 0)
        f.produce(160002)
        assert.equal(journeyValue(f.tables, f.state(), row), 1)
        assert.equal(f.state().journey.targets[row.id].complete, true)
        for (const legacy of f.tables.get('products').filter((r) => String(r.group) === '13'))
            for (const reward of parseRewards(legacy.rewardId))
                assert.equal(productionProgressRule(f.tables, [12018, 8, reward.itemtype, reward.itemid, 1]), false)
        assert.equal(f.tables.get('accessory_product').length, 17)
        assert.equal(productionProgressRule(f.tables, [12018, 8, 33, 0, 1]), true)
    } finally {
        f.store.close()
    }
})

test('new accessory output remains type33 for progress after reward conversion and failed claim cannot reroll or count', () => {
    const f = productionProgressFixture('journey-production-forge'),
        encode = f.protocol.encode
    try {
        const accepted = forge(f),
            tokens = [12018, 8, 33, 0, 1]
        f.advance(accepted.job.seconds)
        assert.equal(productionProgressValue(f.tables, f.state(), tokens), 0)
        for (const type of ['SCJourneySync', 'SCProductFinish']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('journey production codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.finish(accepted), /journey production codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        const packets = f.finish(accepted)
        const data = f.protocol.decode('SCProductFinish', packets.find((row) => row.id === 6111).payload)
        assert.equal(data.reward.rewards[0].itemtype, 15)
        assert.equal(productionProgressValue(f.tables, f.state(), tokens), 1)
        assert.equal(f.state().journey.targets[2030401].complete, true)
        assert.throws(() => f.finish(accepted))
        assert.equal(productionProgressValue(f.tables, f.state(), tokens), 1)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('one real saddle claim satisfies independent achievement and journey rewards while preserving journey gate and retry contracts', () => {
    const f = productionProgressFixture('journey-production-independent'),
        encode = f.protocol.encode
    try {
        f.produce(600029)
        assert.equal(f.state().achievements.entries[2020002].value, 1)
        assert.equal(f.state().journey.targets[2030032].value, 1)
        const locked = structuredClone(f.state())
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [30032] }),
            (e) => e.code === ErrorCode.JourneyTypeLock,
        )
        assert.deepEqual(f.state(), locked)
        // Only the unrelated introductory tab prerequisite is imported for this claim test;
        // no12018 receipt is injected and this does not prove the whole introduction is supported.
        f.edit((s) => {
            s.journey.tasks[20000] = { complete: true, claimed: true }
        })
        f.call('AchievementReward', { u32: 2020002 })
        for (const type of ['SCJourneySync', 'Rewards']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('journey reward codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('JourneyTaskFinish', { u32s: [30032] }), /journey reward codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('JourneyTaskFinish', { u32s: [30032] })
        assert(f.state().journey.targets[2030032].claimed)
        assert(f.state().achievements.entries[2020002].claimed)
        const saved = structuredClone(f.state().journey)
        const retry = f.call('JourneyTaskFinish', { u32s: [30032] })
        assert.deepEqual(f.protocol.decode('Rewards', retry.find((row) => row.id === 9869).payload).rewards, [])
        assert.equal(f.state().journey.targets[2030032].claimed, saved.targets[2030032].claimed)
        f.reload()
        assert(f.state().journey.targets[2030032].claimed)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
