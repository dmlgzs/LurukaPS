import { ErrorCode } from '../error-codes.js'
import { ownedProduction } from '../production-claims.js'
import { spend } from '../inventory.js'
import { refreshProduction } from '../production.js'
import { productionSeconds } from '../production-time.js'
import { ensure, syncPlayer } from './common.js'
import { cookingRecipe, cookingSelection, cookingOutcomes, cookingRequestReceipt } from '../cooking.js'
import { homeCondition } from '../home-grid.js'

export function registerCooking(on, tables) {
    on('CookRequest', (c, r) => {
        const receipt = cookingRequestReceipt(c, r)
        if (receipt.repeated) return { rewards: [] }
        // Home-center management opens this same station queue remotely:
        // CellFreeWorkProduction.OnClickChoose (06029822) sets
        // isFromHomeCenter=true; the current sender does not require HOME_ID.
        // Keep owned, placed and ready building checks, like ProductStart.
        const { h: home, b: build } = ownedProduction(c, r.build_guid)
        const recipe = cookingRecipe(tables, r.cook_id),
            selection = cookingSelection(recipe, r.cook_material),
            variant = recipe.variants.get(selection.baseGrade),
            product = variant.product
        const station = tables.find('home_building_production', build.build_id)
        ensure(station, 'Cooking station configuration is missing', ErrorCode.BuildProductConfNotFound)
        ensure(
            String(product.group).split('|').map(Number).includes(station.groupId),
            'Recipe cannot be cooked at this building',
            ErrorCode.InvalidArgument,
        )
        ensure(
            Number.isInteger(product.time) && product.time > 0,
            'Cooking queue configuration is missing',
            ErrorCode.HomeNoProductConf,
        )
        ensure(
            !product.notReleased && homeCondition(product.unlockCondition, c.state),
            'Cooking recipe locked',
            ErrorCode.CookUnlock,
        )
        ensure(
            !product.isNeedPet || (build.station_pet_guid && build.station_pet_guid !== '0'),
            'Cooking recipe requires a stationed pet',
            ErrorCode.PetNotExist,
        )
        ensure(Number.isInteger(r.cook_count) && r.cook_count > 0, 'Invalid cooking quantity', ErrorCode.CookNumZero)
        ensure(
            Number.isInteger(r.cook_count) && r.cook_count > 0 && r.cook_count <= product.numberLimit,
            'Invalid cooking quantity',
            ErrorCode.CookNumMoreThanMax,
        )
        const supplied = selection.supplied
        // cook_material describes one serving. cook_count multiplies the bag
        // cost server-side (current moduleProductInfoCook.checkDoCook).
        const costs = new Map()
        for (const [id, perServing] of supplied) {
            const count = perServing * r.cook_count
            ensure(Number.isSafeInteger(count) && count <= 0xffffffff, 'Cooking material overflow')
            costs.set(id, count)
        }
        home.productionJobs ??= {}
        const jobs = home.productionJobs[build.guid] || []
        ensure(
            Number.isInteger(station.productionQueueNum) &&
                station.productionQueueNum > 0 &&
                jobs.length < station.productionQueueNum,
            'Cooking queue is full',
            ErrorCode.ProductQueueFull,
        )
        const seconds = productionSeconds(tables, c.state, build, product)
        const start = Math.max(c.now, ...jobs.map((job) => job.start + job.count * job.seconds))
        ensure(start + r.cook_count * seconds <= 0xffffffff, 'Cooking finish time overflow')
        const allJobs = Object.values(home.productionJobs).flat()
        ensure(
            home.nextProductGuid === undefined ||
                (Number.isSafeInteger(home.nextProductGuid) && home.nextProductGuid > 0),
            'Invalid cooking job allocator',
            ErrorCode.GameConfig,
        )
        const guid = Math.max(home.nextProductGuid ?? 1, 1, ...allJobs.map((job) => job.guid + 1))
        ensure(Number.isSafeInteger(guid) && guid <= 0xffffffff, 'Cooking job identity exhausted', ErrorCode.GameConfig)
        spend(c.state, costs, 0, c.now)
        const cookingUnits = cookingOutcomes(recipe, selection, r.cook_count, c.randomInt)
        home.nextProductGuid = guid + 1
        jobs.push({
            kind: 'cook',
            guid,
            productId: product.id,
            count: r.cook_count,
            claimed: 0,
            start,
            seconds,
            costs: [...supplied].map(([itemid, itemnum]) => ({ itemtype: 3, itemid, itemnum })),
            rewards: variant.rewards,
            cookingConfigId: recipe.id,
            cookingUnits,
            reportedDone: 0,
        })
        home.productionJobs[build.guid] = jobs
        receipt.commit()
        c.reconcileProductionWork?.()
        refreshProduction(c.state, c.now)
        syncPlayer(c, { sbag_infos: c.state.player.sbag_infos })
        return { rewards: [] }
    })
}
