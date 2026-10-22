import { acquiredResourceCount } from './item-acquisition.js'
import fs from 'node:fs'
import path from 'node:path'
import { configuration } from './config.js'
import { deliveryKey } from './task-delivery.js'

const conditions = new Map(
    JSON.parse(fs.readFileSync(path.join(configuration().tables, 'task_condition.json'), 'utf8')).map((row) => [
        row.id,
        row,
    ]),
)
const buildingGroups = new Map(
    JSON.parse(fs.readFileSync(new URL('../configs/client-tables/home_building.json', import.meta.url), 'utf8')).map(
        (row) => [row.id, row.groupId],
    ),
)
const fieldGroups = new Set([2016, 2033])
const shopTableDir = configuration().tables
const shopTable = (name) => JSON.parse(fs.readFileSync(path.join(shopTableDir, `${name}.json`), 'utf8'))
const shopSlots = new Map(shopTable('shop_slot').map((row) => [row.slotId, row.slotParam]))
const goods = new Map(shopTable('goods').map((row) => [row.goodsId, row]))
const commonItemTypes = new Map(shopTable('common_item').map((row) => [row.id, row.type]))
const productRows = new Map(shopTable('products').map((row) => [row.id, row]))
const petGroups = new Map(
    JSON.parse(fs.readFileSync(new URL('../configs/task-tables/pet_rank.json', import.meta.url), 'utf8')).map((row) => [
        row.petId,
        row.petGroup,
    ]),
)

export function guidedKillRule(id) {
    const parts = String(conditions.get(id)?.condition ?? '')
        .split('|')
        .map(Number)
    if (
        parts.length !== 6 ||
        parts[0] !== 12002 ||
        !parts.every(Number.isInteger) ||
        parts.slice(1).some((n) => n < 0) ||
        parts[5] <= 0
    )
        return null
    return { sceneType: parts[1], monsterType: parts[2], groupId: parts[3], monsterId: parts[4], count: parts[5] }
}
export function guidedCollectRule(id) {
    const parts = String(conditions.get(id)?.condition ?? '')
        .split('|')
        .map(Number)
    if (
        parts.length !== 4 ||
        parts[0] !== 12029 ||
        ![3, 13].includes(parts[1]) ||
        !parts.every(Number.isSafeInteger) ||
        parts[2] <= 0 ||
        parts[3] <= 0
    )
        return null
    return { type: parts[1], id: parts[2], count: parts[3] }
}
export function guidedRequirement(id) {
    const kill = guidedKillRule(id)
    if (kill) return kill.count
    const collect = guidedCollectRule(id)
    if (collect) return collect.count
    const param = Number(conditions.get(id)?.param)
    return Number.isInteger(param) && param > 0 ? param : 1
}

export function guidedConditionValue(id, state, context, providedRow) {
    const row = providedRow ?? conditions.get(id)
    if (!row) return 0
    const collect = guidedCollectRule(id)
    if (collect) return Math.min(collect.count, acquiredResourceCount(state, collect.type, collect.id))
    const parts = String(row.condition || '')
        .split('|')
        .map(Number)
    if (guidedKillRule(id))
        return context?.taskId !== undefined && context.nodeId !== undefined && context.index !== undefined
            ? (state.taskEvents?.[deliveryKey(state, context.taskId, context.nodeId, context.index)] ?? 0)
            : 0
    // HaveCommonItem checks current bag stock, irrespective of how it was
    // granted. Finished-but-unclaimed production and lifetime craft counts
    // are not owned items. Sum all stacks of the exact configured item ID.
    if (
        parts.length === 3 &&
        parts[0] === 12041 &&
        parts.slice(1).every((value) => Number.isSafeInteger(value) && value > 0)
    )
        return (state.player?.sbag_infos?.items ?? []).reduce(
            (count, item) =>
                count +
                (item.itemid === parts[1] && Number.isSafeInteger(item.itemnum) && item.itemnum > 0 ? item.itemnum : 0),
            0,
        )
    // HomePetStation: pet group, exact pet ID, EStationType, capacity, count.
    // EStationType.Crop=3 counts occupied, placed field-house work slots.
    if (
        parts.length === 6 &&
        parts[0] === 12032 &&
        parts[3] === 3 &&
        [parts[1], parts[2], parts[4]].every((value) => Number.isInteger(value) && value >= 0) &&
        Number.isInteger(parts[5]) &&
        parts[5] > 0
    ) {
        const stationed = new Set()
        for (const build of state.home?.builds ?? []) {
            if (build.build_type !== 16 || !build.locate) continue
            for (const [capacity, field] of [
                [1001, 'plant_pet'],
                [1002, 'water_pet'],
                [1003, 'harvest_pet'],
            ]) {
                if (parts[4] && capacity !== parts[4]) continue
                const id = build.auto_info?.[field]
                const pet = (state.pets ?? []).find(
                    (pet) =>
                        pet.guid === id &&
                        pet.work_status === 5 &&
                        pet.work_build === build.guid &&
                        pet.capacity_id === capacity,
                )
                if (
                    !pet ||
                    (parts[1] && petGroups.get(pet.config_id) !== parts[1]) ||
                    (parts[2] && pet.config_id !== parts[2])
                )
                    continue
                stationed.add(id)
            }
        }
        return stationed.size
    }
    // conditionNode_50002 checks the configured duel's nonzero success_time.
    // Preparation, entering the arena or losing cannot satisfy the quest.
    if (parts.length === 2 && parts[0] === 50002)
        return Number(state.kiboDuelRecords?.[parts[1]]?.success_time ?? 0) > 0 ? guidedRequirement(id) : 0
    // DungeonEntrustFinish checks the best star count of the configured
    // commission. A mere EnterEntrust request never completes this condition.
    if (
        parts.length === 3 &&
        parts[0] === 13044 &&
        Number.isInteger(parts[1]) &&
        parts[1] > 0 &&
        Number.isInteger(parts[2]) &&
        parts[2] > 0
    )
        return state.entrust?.records?.[parts[1]]?.entrust_star ?? 0
    // CBT3 common_condition 12030 is ActivationPoint. The local server seeds
    // all configured transfer points, so evaluate the configured point ID
    // against that authoritative unlocked-point list.
    if (parts.length === 2 && parts[0] === 12030 && Number.isInteger(parts[1]) && parts[1] > 0)
        return (state.world?.points ?? []).includes(parts[1]) ? 1 : 0
    // CBT3 conditionNode_12027 reads HomeStore buildingBag.used_num by group.
    if (
        parts.length === 3 &&
        parts[0] === 12027 &&
        Number.isInteger(parts[1]) &&
        Number.isInteger(parts[2]) &&
        parts[2] > 0
    ) {
        // The client counts dry and fertile fields from placed home builds.
        if (fieldGroups.has(parts[1]))
            return (state.home?.builds ?? []).filter((build) => buildingGroups.get(build.build_id) === parts[1]).length
        return (state.home?.inventory ?? []).reduce(
            (sum, entry) =>
                sum + (buildingGroups.get(entry.build_id) === parts[1] ? Math.max(0, Number(entry.used_num) || 0) : 0),
            0,
        )
    }
    // ShopPurchaseGoods uses the shop, reward type, common-item type, item ID
    // and purchased quantity. Inventory is not a purchase counter: the seeds
    // may already have been sown when the task progress is refreshed.
    if (
        parts.length === 6 &&
        parts[0] === 12033 &&
        parts.slice(1).every((value) => Number.isInteger(value) && value > 0)
    ) {
        const [, shopId, rewardType, itemType, itemId] = parts
        if (rewardType !== 3 || commonItemTypes.get(itemId) !== itemType) return 0
        return Object.entries(state.shopPurchases ?? {}).reduce((total, [key, record]) => {
            const [purchasedShop, slot] = key.split(':').map(Number)
            if (purchasedShop !== shopId) return total
            const item = goods.get(shopSlots.get(slot))
            if (!item) return total
            const quantity = String(item.item || '')
                .split('|')
                .map((reward) => reward.split('#').map(Number))
                .filter(([type, id, count]) => type === rewardType && id === itemId && count > 0)
                .reduce((sum, [, , count]) => sum + count, 0)
            return total + quantity * (record.count || 0)
        }, 0)
    }
    // WateringFrequency counts accepted player watering actions. Keep this
    // counter after a crop is harvested, as the task is about completed work.
    if (parts.length === 2 && parts[0] === 13020 && Number.isInteger(parts[1]) && parts[1] > 0)
        return state.home?.manualWaterCount ?? 0
    // HomeProducts counts output collected from the configured recipe. Jobs
    // still in a production queue do not count as completed food.
    if (
        parts.length === 5 &&
        parts[0] === 12018 &&
        parts.slice(1).every((value) => Number.isInteger(value) && value > 0) &&
        row.formulaId > 0
    ) {
        const recipe = productRows.get(row.formulaId)
        const [, , rewardType, itemId] = parts
        const perCraft = String(recipe?.rewardId || '')
            .split('|')
            .map((entry) => entry.split('#').map(Number))
            .filter(([type, id, count]) => type === rewardType && id === itemId && count > 0)
            .reduce((sum, [, , count]) => sum + count, 0)
        return (
            perCraft * (state.home?.craftCounts?.[row.formulaId] ?? 0) +
            (parts[1] === 10 && rewardType === 3 ? (state.home?.cookCounts?.[itemId] ?? 0) : 0)
        )
    }
    // KiboBoardFoodType counts distinct foods stocked at placed pet tables.
    // A bag item or an empty/removable table does not satisfy this condition.
    if (parts.length === 2 && parts[0] === 12211 && Number.isInteger(parts[1]) && parts[1] > 0) {
        const types = new Set()
        for (const build of state.home?.builds ?? []) {
            if (build.build_type !== 6 || !build.locate) continue
            for (const food of build.pet_canteen?.foods ?? [])
                if (food.itemnum > 0 && commonItemTypes.get(food.itemid) === 355) types.add(food.itemid)
        }
        return types.size
    }
    // KiboBoardFoodNum reads food actually stocked at placed pet tables.
    if (
        parts.length === 3 &&
        parts[0] === 15013 &&
        parts.slice(1).every((value) => Number.isInteger(value) && value > 0)
    )
        return (state.home?.builds ?? []).reduce(
            (total, build) =>
                total +
                (build.build_type === 6
                    ? (build.pet_canteen?.foods ?? [])
                          .filter((food) => food.itemid === parts[1])
                          .reduce((sum, food) => sum + food.itemnum, 0)
                    : 0),
            0,
        )
    // common_condition 12067 is PortableProduction. The table specifies the
    // produced reward type and ID; only settled quick-production output counts.
    if (
        parts.length === 4 &&
        parts[0] === 12067 &&
        [parts[1], parts[2], parts[3]].every((n) => Number.isInteger(n) && n > 0)
    )
        return state.simpleProduced?.[`${parts[1]}:${parts[2]}`] ?? 0
    // BuildingCollectionSituation counts products collected from the configured
    // building recipe. craftCounts advances only when ProductFinish grants the
    // output, so already collected items remain credited after they are used.
    if (
        parts.length === 4 &&
        parts[0] === 13025 &&
        [parts[1], parts[2], parts[3], row.formulaId].every((n) => Number.isInteger(n) && n > 0)
    )
        return state.home?.craftCounts?.[row.formulaId] ?? 0
    // HomeHubKibo mode 1 counts pets actually stationed in the home hub.
    if (parts.length === 3 && parts[0] === 12070 && parts[1] === 1 && Number.isInteger(parts[2]) && parts[2] > 0) {
        const stationed = new Set((state.home?.stationPets ?? []).map(String))
        return (state.pets ?? []).filter((pet) => stationed.has(String(pet.guid)) && pet.work_status === 7).length
    }
    // common_condition 12040 is HavePet. Its rows identify a pet group,
    // optional exact pet ID (0 means any within the group), and count.
    if (
        parts.length === 4 &&
        parts[0] === 12040 &&
        Number.isInteger(parts[1]) &&
        parts[1] > 0 &&
        Number.isInteger(parts[2]) &&
        parts[2] >= 0 &&
        Number.isInteger(parts[3]) &&
        parts[3] > 0
    )
        return (state.pets ?? []).filter(
            (p) => petGroups.get(p.config_id) === parts[1] && (!parts[2] || p.config_id === parts[2]),
        ).length
    return 0
}
