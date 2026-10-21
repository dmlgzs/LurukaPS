import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { materialDungeonUnlocked } from './material-dungeons.js'
import { parseRewards } from './rewards.js'
import { WorldObjectCatalog } from './world-objects.js'
import { customOrnamentConfiguration } from './ornaments.js'
import { productionSeconds } from './production-time.js'

const catalogs = new WeakMap()
function catalog(tables) {
    if (!catalogs.has(tables)) catalogs.set(tables, new WorldObjectCatalog(tables))
    return catalogs.get(tables)
}
export function accessoryProductionChoices(tables, dropId) {
    const drops = catalog(tables),
        byDrop = new Map(),
        leaves = new Map()
    for (const row of drops.get('drop')) {
        if (!byDrop.has(row.dropId)) byDrop.set(row.dropId, [])
        byDrop.get(row.dropId).push(row)
    }
    const walk = (id, path = []) => {
        ensure(path.length < 16 && !path.includes(id), 'Recursive accessory production drop', ErrorCode.GameConfig)
        const rows = byDrop.get(id)
        ensure(rows?.length, 'Accessory production drop unavailable', ErrorCode.GameConfig)
        ensure(
            new Set(rows.map((row) => row.dropGroupId)).size === 1,
            'Accessory production multi-output pool is not implemented',
            ErrorCode.FunctionClosed,
        )
        ensure(
            rows.every((row) => Number.isSafeInteger(row.weight) && row.weight >= 0) &&
                rows.some((row) => row.weight > 0),
            'Invalid accessory production weights',
            ErrorCode.GameConfig,
        )
        for (const row of rows) {
            ensure(
                !row.tacticsGroup && !row.tacticsWeight && !row.tacticsValue && !row.allowanceValue,
                'Accessory production tactics are not implemented',
                ErrorCode.FunctionClosed,
            )
            if (!row.weight) continue
            ensure(
                row.minValue === 1 && row.maxValue === 1,
                'Accessory production output quantity is not implemented',
                ErrorCode.FunctionClosed,
            )
            if (row.type === 27) walk(row.itemId, [...path, id])
            else {
                ensure(
                    row.type === 33,
                    'Accessory production output category is not implemented',
                    ErrorCode.FunctionClosed,
                )
                customOrnamentConfiguration(tables, row.itemId)
                leaves.set(row.itemId, { itemtype: 33, itemid: row.itemId, itemnum: 1 })
            }
        }
    }
    walk(dropId)
    return { drops, leaves }
}
function discounts(tables, state) {
    const level = state.home?.technology?.levels?.[10093]?.level
    if (!level) return new Map()
    const rows = tables.get('home_technology').filter((row) => row.type === 10093 && row.level === level)
    ensure(rows.length === 1, 'Accessory cost technology configuration unavailable', ErrorCode.GameConfig)
    // Current native GetTechnologyBuffValuedOfItemId scans the first list.
    const values = String(rows[0].buffParams).split('|')[0].split('#').map(Number)
    ensure(
        values.length % 2 === 0 && values.every(Number.isSafeInteger),
        'Invalid accessory cost discount',
        ErrorCode.GameConfig,
    )
    const result = new Map()
    for (let i = 0; i < values.length; i += 2) {
        ensure(
            values[i] > 0 && values[i + 1] >= 0 && values[i + 1] <= 10000,
            'Invalid accessory discount rate',
            ErrorCode.GameConfig,
        )
        if (!result.has(values[i])) result.set(values[i], values[i + 1])
    }
    return result
}
function costsFor(text, rates) {
    return parseRewards(text)
        .map((row) => {
            ensure(
                [3, 10].includes(row.itemtype),
                'Accessory material category is not implemented',
                ErrorCode.FunctionClosed,
            )
            // Match Conv.r4/div in GetCostItemNum, then its <=1 ceil / >1 floor.
            const fraction = Math.fround(Math.fround(row.itemnum * (rates.get(row.itemid) ?? 0)) / 10000)
            const reduction = fraction <= 1 ? Math.ceil(fraction) : Math.floor(fraction)
            return { ...row, itemnum: Math.max(0, row.itemnum - reduction) }
        })
        .filter((row) => row.itemnum > 0)
}
export function accessoryProductionPlan(tables, state, build, request) {
    const recipe = tables.find('accessory_product', request.product_id)
    ensure(recipe, 'Accessory production recipe unavailable', ErrorCode.ProductConfNotExist)
    const station = tables.find('home_building_production', build.build_id)
    ensure(station, 'Production station configuration unavailable', ErrorCode.BuildProductConfNotFound)
    ensure(
        String(recipe.group).split('|').map(Number).includes(station.groupId),
        'Recipe does not match this station',
        ErrorCode.ProductConfReqGroupNotMatch,
    )
    ensure(
        materialDungeonUnlocked(recipe.unlockCondition, state),
        'Accessory production recipe is locked',
        ErrorCode.ProductUnlockCondition,
    )
    ensure(
        !request.ornament_guid,
        'Current accessory production does not consume an existing ornament',
        ErrorCode.ProductSelectMaterialFail,
    )
    ensure(
        Number.isSafeInteger(station.productionQueueNum) && station.productionQueueNum > 0,
        'Invalid production queue configuration',
        ErrorCode.GameConfig,
    )
    const jobs = state.home?.productionJobs?.[build.guid] ?? []
    ensure(
        Number.isSafeInteger(request.count) && request.count > 0,
        'Invalid accessory production count',
        ErrorCode.HomeProductStartContError,
    )
    ensure(
        request.count <= station.productionQueueNum - jobs.length,
        'Accessory production queue is full',
        ErrorCode.ProductQueueFull,
    )
    const choices = accessoryProductionChoices(tables, recipe.dropId),
        target = request.designated_item_id ?? 0
    ensure(
        Number.isSafeInteger(target) && target >= 0 && (!target || choices.leaves.has(target)),
        'Designated accessory is not in this production pool',
        ErrorCode.ProductSelectMaterialFail,
    )
    const rates = discounts(tables, state),
        baseCosts = costsFor(recipe.material, rates),
        locateCosts = target ? costsFor(recipe.locateCost, rates) : []
    const costs = new Map()
    for (const cost of [...baseCosts, ...locateCosts]) {
        const key = cost.itemtype + ':' + cost.itemid,
            old = costs.get(key),
            num = (old?.itemnum ?? 0) + cost.itemnum
        ensure(
            Number.isSafeInteger(num) && num <= 0xffffffff,
            'Accessory production cost overflow',
            ErrorCode.GameConfig,
        )
        costs.set(key, { ...cost, itemnum: num })
    }
    ensure(
        Number.isSafeInteger(recipe.time) && recipe.time > 0 && recipe.time * 60 <= 0xffffffff,
        'Accessory production duration unavailable',
        ErrorCode.HomeNoProductConf,
    )
    const seconds = productionSeconds(tables, state, build, { ...recipe, time: recipe.time * 60 })
    return { recipe, target, costs: [...costs.values()], locateCosts, seconds, ...choices }
}
