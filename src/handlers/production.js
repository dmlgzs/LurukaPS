import { ErrorCode } from '../error-codes.js'
import { productionTables } from '../production-tables.js'
import { productionMaterials } from '../production-materials.js'
import { ensure, syncPlayer } from './common.js'
import { homeCondition } from '../home-grid.js'
import { parseRewards } from '../rewards.js'
import { spend, spendCurrency } from '../inventory.js'
import { refreshProduction } from '../production.js'
import { productionSeconds } from '../production-time.js'
import { accessoryProductionPlan } from '../accessory-production.js'
import {
    multiplyProductionRows as multiplied,
    ownedProduction as owned,
    claimProductionStock,
} from '../production-claims.js'
export function registerProduction(on, tables) {
    tables = productionTables(tables)
    on('ProductOrnamentStart', (c, r) => {
        const { h, b } = owned(c, r.build_guid),
            plan = accessoryProductionPlan(tables, c.state, b, r)
        // TODO: settle technologyExp through the category/rule XP model.
        // "1#10201" identifies an XP category/rule, not 10201 XP to grant.
        h.productionJobs ??= {}
        const jobs = h.productionJobs[b.guid] ?? [],
            allJobs = Object.values(h.productionJobs).flat()
        ensure(
            h.nextProductGuid === undefined || (Number.isSafeInteger(h.nextProductGuid) && h.nextProductGuid > 0),
            'Invalid product GUID allocator',
            ErrorCode.GameConfig,
        )
        let next = Math.max(h.nextProductGuid ?? 1, ...allJobs.map((job) => job.guid + 1))
        ensure(next + r.count - 1 <= 0xffffffff, 'Product GUID space exhausted', ErrorCode.GameConfig)
        let start = Math.max(c.now, ...jobs.map((job) => job.start + job.count * job.seconds))
        ensure(
            Number.isSafeInteger(start) && start + r.count * plan.seconds <= 0xffffffff,
            'Production timestamp overflow',
            ErrorCode.GameConfig,
        )
        const bag = new Map()
        for (const cost of multiplied(plan.costs, r.count)) {
            if (cost.itemtype === 3) bag.set(cost.itemid, (bag.get(cost.itemid) ?? 0) + cost.itemnum)
            else spendCurrency(c.state, cost.itemid, cost.itemnum)
        }
        spend(c.state, bag, 0, c.now)
        for (let i = 0; i < r.count; i++) {
            // Local policy: retain the pool result with the accepted job so a
            // failed claim cannot reroll it. Official roll timing is unverified.
            const rewards = plan.target
                ? [{ ...plan.leaves.get(plan.target) }]
                : plan.drops.drops(plan.recipe.dropId, c.randomInt)
            ensure(
                rewards.length === 1 &&
                    rewards[0].itemtype === 33 &&
                    rewards[0].itemnum === 1 &&
                    plan.leaves.has(rewards[0].itemid),
                'Accessory production result is outside the validated pool',
                ErrorCode.GameConfig,
            )
            jobs.push({
                kind: 'accessory',
                guid: next++,
                productId: plan.recipe.id,
                count: 1,
                claimed: 0,
                start,
                seconds: plan.seconds,
                costs: plan.costs,
                rewards,
                designatedItemId: plan.target,
                designateCosts: plan.locateCosts,
                reportedDone: 0,
            })
            start += plan.seconds
        }
        h.nextProductGuid = next
        h.productionJobs[b.guid] = jobs
        refreshProduction(c.state, c.now)
        return { rewards: [] }
    })
    on('ProductStart', (c, r) => {
        const { h, b } = owned(c, r.build_guid),
            recipe = tables.find('products', r.product_id),
            station = tables.find('home_building_production', b.build_id)
        ensure(recipe && station, 'Unknown recipe or production station')
        ensure(
            String(recipe.group).split('|').map(Number).includes(station.groupId),
            'Recipe cannot be produced at this building',
        )
        ensure(homeCondition(recipe.unlockCondition, c.state), 'Production recipe locked')
        // Quality recipes supply their ingredients through CookRequest. Their
        // products.material is empty; accepting ProductStart would create free flour.
        ensure(
            !tables.get('products_multi_quality').some((row) => row.productId === recipe.id),
            'Quality production requires CookRequest materials',
        )
        ensure(!recipe.isNeedPet, 'Pet-assisted production is not implemented', ErrorCode.InvalidProtoID)
        ensure(!recipe.notReleased, 'Recipe not released')
        ensure(Number.isInteger(r.count) && r.count > 0 && r.count <= recipe.numberLimit, 'Invalid production count')
        ensure(
            Number.isInteger(recipe.time) && recipe.time > 0,
            'Unsupported production duration',
            ErrorCode.HomeNoProductConf,
        )
        const costs = productionMaterials(tables, recipe, r.select_material ?? []),
            rewards = parseRewards(recipe.rewardId)
        ensure(rewards.length > 0, 'Recipe uses unresolved reward logic', ErrorCode.InvalidProtoID)
        ensure(
            costs.every((x) => [3, 10].includes(x.itemtype)),
            'Unsupported production material',
            ErrorCode.InvalidProtoID,
        )
        ensure(
            rewards.every((x) => [3, 10, 13, 14, 25].includes(x.itemtype)),
            'Unsupported production reward',
            ErrorCode.InvalidProtoID,
        )
        h.productionJobs ??= {}
        const jobs = h.productionJobs[b.guid] || []
        ensure(
            Number.isInteger(station.productionQueueNum) &&
                station.productionQueueNum > 0 &&
                jobs.length < station.productionQueueNum,
            'Production queue is full',
        )
        const seconds = productionSeconds(tables, c.state, b, recipe)
        const start = Math.max(c.now, ...jobs.map((j) => j.start + j.count * j.seconds))
        ensure(start + r.count * seconds <= 0xffffffff, 'Production timestamp overflow')
        const allCosts = multiplied(costs, r.count),
            bag = new Map()
        for (const cost of allCosts) {
            if (cost.itemtype === 3) bag.set(cost.itemid, (bag.get(cost.itemid) || 0) + cost.itemnum)
            else spendCurrency(c.state, cost.itemid, cost.itemnum)
        }
        if (bag.size) spend(c.state, bag, 0, c.now)
        const guid = h.nextProductGuid || 1
        ensure(guid <= 0xffffffff, 'Product GUID space exhausted')
        h.nextProductGuid = guid + 1
        jobs.push({
            guid,
            productId: recipe.id,
            count: r.count,
            claimed: 0,
            start,
            seconds,
            costs,
            rewards,
            reportedDone: 0,
        })
        h.productionJobs[b.guid] = jobs
        refreshProduction(c.state, c.now)
        syncPlayer(c, {
            basic_info: c.state.player.basic_info,
            attr_infos: c.state.player.attr_infos,
            sbag_infos: c.state.player.sbag_infos,
        })
        return { rewards: [] }
    })
    for (const cancel of [false, true])
        on(cancel ? 'ProductCancel' : 'ProductFinish', (c, r) => {
            const result = claimProductionStock(c, r, { cancel })
            syncPlayer(c)
            return result
        })
}
