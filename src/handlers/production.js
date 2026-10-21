import { ErrorCode } from '../error-codes.js'
import { productionTables } from '../production-tables.js'
import { productionMaterials } from '../production-materials.js'
import { claimHatch, cancelHatch } from '../hatching.js'
import { ensure, syncPlayer } from './common.js'
import { ensureHome } from '../home.js'
import { homeCondition } from '../home-grid.js'
import { parseRewards, grantRewards } from '../rewards.js'
import { spend, spendCurrency } from '../inventory.js'
import { completed, refreshProduction, rescheduleJobs } from '../production.js'
import { productionSeconds } from '../production-time.js'
function multiplied(rows, count) {
    return rows.map((r) => {
        const n = r.itemnum * count
        ensure(Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff, 'Production quantity overflow')
        return { ...r, itemnum: n }
    })
}
function owned(c, guid) {
    const h = ensureHome(c.tables, c.state),
        b = h.builds.find((b) => b.guid === guid)
    ensure(b, 'Production building is not owned/placed')
    ensure([1, 4].includes(b.status), 'Building is under construction')
    return { h, b }
}
export function registerProduction(on, tables) {
    tables = productionTables(tables)
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
            const { h, b } = owned(c, r.guid),
                jobs = h.productionJobs?.[b.guid] || []
            const ids = r.is_all ? jobs.map((j) => j.guid) : r.product_guids
            ensure(ids.length > 0 && new Set(ids).size === ids.length, 'Invalid production selection')
            const selected = ids.map((id) => {
                const j = jobs.find((j) => j.guid === id)
                ensure(j, 'Product is not in this building')
                return j
            })
            const rewards = []
            let claimed = 0
            for (const job of selected) {
                if (job.kind === 'hatch') {
                    if (cancel) cancelHatch(c, job)
                    else if (completed(job, c.now)) {
                        rewards.push(claimHatch(c, job))
                        claimed++
                    }
                    continue
                }
                const done = completed(job, c.now),
                    available = done - job.claimed
                if (available > 0) {
                    rewards.push(...grantRewards(tables, c.state, multiplied(job.rewards, available)))
                    job.claimed += available
                    claimed += available
                    h.craftCounts ??= {}
                    h.craftCounts[job.productId] = (h.craftCounts[job.productId] || 0) + available
                }
                if (cancel) {
                    const unfinished = job.count - done
                    if (unfinished > 0)
                        rewards.push(...grantRewards(tables, c.state, multiplied(job.costs, unfinished)))
                }
            }
            ensure(cancel || claimed > 0, 'No finished production available')
            h.productionJobs[b.guid] = jobs.filter((j) => !(cancel && ids.includes(j.guid)) && j.claimed < j.count)
            if (cancel) rescheduleJobs(h.productionJobs[b.guid], c.now)
            refreshProduction(c.state, c.now)
            c.state.homeRevision = (c.state.homeRevision || 0) + 1
            syncPlayer(c)
            return { build: b, reward: { rewards } }
        })
}
