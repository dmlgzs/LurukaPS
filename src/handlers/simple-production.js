import { ErrorCode } from '../error-codes.js'
import { productionTables } from '../production-tables.js'
import { productionMaterials } from '../production-materials.js'
import { ensure, syncPlayer } from './common.js'
import { parseRewards, grantRewards } from '../rewards.js'
import { spend, spendCurrency } from '../inventory.js'
import { homeCondition } from '../home-grid.js'
import { completed } from '../production.js'
import {
    simpleProductSnapshot,
    settleSimpleProducts,
    multiplySimpleRows,
    rememberClosedSimpleProduct,
} from '../simple-production.js'

export function registerSimpleProduction(on, tables) {
    tables = productionTables(tables)
    on('SimpleProductStart', (c, r) => {
        const recipe = tables.find('products', r.product_id)
        ensure(recipe?.isQuickProduct === 1 && !recipe.notReleased, 'Unknown quick-production recipe')
        ensure(!r.build_guid, 'Quick production must not use a building')
        ensure(homeCondition(recipe.unlockCondition, c.state), 'Production recipe locked')
        ensure(!recipe.isNeedPet, 'Pet-assisted quick production is not implemented', ErrorCode.InvalidProtoID)
        ensure(Number.isInteger(r.count) && r.count > 0 && r.count <= recipe.numberLimit, 'Invalid production count')
        ensure(
            Number.isInteger(recipe.time) && recipe.time > 0 && c.now + r.count * recipe.time <= 0xffffffff,
            'Invalid production duration',
            ErrorCode.HomeNoProductConf,
        )
        const costs = productionMaterials(tables, recipe, r.select_material ?? []),
            rewards = parseRewards(recipe.rewardId)
        ensure(
            costs.length && costs.every((x) => [3, 10].includes(x.itemtype)),
            'Unsupported quick-production material',
            ErrorCode.InvalidProtoID,
        )
        ensure(
            rewards.length && rewards.every((x) => [3, 10].includes(x.itemtype)),
            'Unsupported quick-production reward',
            ErrorCode.InvalidProtoID,
        )
        const settled = settleSimpleProducts(tables, c.state, c.now)
        // CBT3 ProductManager.onIsHadIdleQueueWithFastProduct uses four slots.
        const jobs = (c.state.simpleProducts ??= [])
        ensure(jobs.length < 4, 'Quick-production queue is full')
        const allCosts = multiplySimpleRows(costs, r.count),
            bag = new Map()
        for (const cost of allCosts) {
            if (cost.itemtype === 3) bag.set(cost.itemid, (bag.get(cost.itemid) ?? 0) + cost.itemnum)
            else spendCurrency(c.state, cost.itemid, cost.itemnum)
        }
        if (bag.size) spend(c.state, bag, 0, c.now)
        const guid = c.state.nextSimpleProductGuid ?? 1
        ensure(Number.isInteger(guid) && guid > 0 && guid <= 0xffffffff, 'Quick-production GUID exhausted')
        c.state.nextSimpleProductGuid = guid + 1
        jobs.push({
            guid,
            productId: recipe.id,
            count: r.count,
            credited: 0,
            reportedDone: 0,
            start: c.now,
            seconds: recipe.time,
            costs,
            rewards,
        })
        syncPlayer(c)
        c.push('CSProtoSimpleProductFinish', {
            ...simpleProductSnapshot(c.state),
            reward: { rewards: settled.rewards },
            dels: settled.dels,
        })
        return {}
    })
    on('SimpleProductCancel', (c, r) => {
        const known =
            (c.state.simpleProducts ?? []).some((job) => job.guid === r.u32) ||
            (c.state.simpleProductCompleted ?? []).includes(r.u32)
        ensure(known, 'Quick-production job not found')
        const settled = settleSimpleProducts(tables, c.state, c.now),
            jobs = c.state.simpleProducts ?? [],
            job = jobs.find((x) => x.guid === r.u32)
        let refund = []
        if (job) {
            const unfinished = job.count - completed(job, c.now)
            if (unfinished) refund = grantRewards(tables, c.state, multiplySimpleRows(job.costs, unfinished))
            c.state.simpleProducts = jobs.filter((x) => x.guid !== job.guid)
            rememberClosedSimpleProduct(c.state, job.guid)
        }
        syncPlayer(c)
        c.push('CSProtoSimpleProductFinish', {
            ...simpleProductSnapshot(c.state),
            reward: { rewards: [...settled.rewards, ...refund] },
            dels: [...new Set([...settled.dels, r.u32])],
        })
        return {}
    })
}
