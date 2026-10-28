import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0

export function canteenFoodScore(tables, id, stored = false) {
    const item = tables.find('common_item', id)
    ensure(item, 'Food item configuration is missing', ErrorCode.GameConfig)
    ensure(item.type === 355, 'Item is not food', stored ? ErrorCode.GameConfig : ErrorCode.ItemIsNotFood)
    const food = tables.find('food', id)
    ensure(food, 'Food configuration is missing', ErrorCode.FoodConfNotExist)
    ensure(
        uint(food.satietyScore) && food.satietyScore <= 0x7fffffff,
        'Food satiety configuration is malformed',
        ErrorCode.GameConfig,
    )
    ensure(
        food.satietyScore > 0,
        'Food has no pet satiety use',
        stored ? ErrorCode.GameConfig : ErrorCode.FoodIsNotPetUse,
    )
    return food.satietyScore
}

export function readCanteenFoodLedger(tables, canteen) {
    ensure(
        canteen && typeof canteen === 'object' && !Array.isArray(canteen),
        'Invalid canteen state',
        ErrorCode.GameConfig,
    )
    ensure(Array.isArray(canteen.foods), 'Invalid stocked food list', ErrorCode.GameConfig)
    const foods = new Map()
    let value = 0n
    for (const entry of canteen.foods) {
        ensure(
            entry &&
                positive(entry.itemid) &&
                positive(entry.itemnum) &&
                (entry.itemtype === undefined || entry.itemtype === 3),
            'Invalid stocked food record',
            ErrorCode.GameConfig,
        )
        ensure(!foods.has(entry.itemid), 'Duplicate stocked food record', ErrorCode.GameConfig)
        value += BigInt(entry.itemnum) * BigInt(canteenFoodScore(tables, entry.itemid, true))
        ensure(value <= 0xffffffffn, 'Stocked food value overflow', ErrorCode.GameConfig)
        foods.set(entry.itemid, entry.itemnum)
    }
    // Whole-dish transfers must not rebuild unknown consumed/partial ledgers.
    const saved = canteen.food_value ?? 0
    ensure(
        uint(saved) && BigInt(saved) === value,
        'Stocked food value does not match whole dishes',
        ErrorCode.GameConfig,
    )
    return foods
}
