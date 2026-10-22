import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'
import { WorldObjectCatalog } from './world-objects.js'

const catalogs = new WeakMap()
const giftTypes = new Set([1, 2, 3, 24, 25, 26])
export const isGiftItem = (row) => giftTypes.has(row?.useType)

// The talent material picker sends one [resource type, config ID] per
// selectable box. Keep per-entry arguments: one box may be opened twice
// with different selections in the same batch.
export function itemGiftRewards(tables, item, request, randomInt) {
    ensure(isGiftItem(item), 'Unsupported item use type', ErrorCode.FunctionClosed)
    if (item.useType === 3 || item.useType === 26) {
        const choices = parseRewards(item.giftBagReward)
        ensure(choices.length, 'Selectable gift has no choices', ErrorCode.SelectGiftIsNull)
        ensure(request.args?.length === 2, 'Selectable gift requires type and ID', ErrorCode.SelectGiftArgsSize)
        const [type, id] = request.args.map(Number)
        ensure(
            [type, id].every((value) => Number.isSafeInteger(value) && value > 0),
            'Invalid gift choice',
            ErrorCode.SelectGiftArgsSize,
        )
        const selected = choices.filter((row) => row.itemtype === type && row.itemid === id)
        ensure(selected.length, 'Selected item is not in this gift', ErrorCode.SelectGiftItemNotExist)
        ensure(selected.length === 1, 'Duplicate gift choices', ErrorCode.GameConfig)
        const count = selected[0].itemnum * request.num
        ensure(Number.isSafeInteger(count) && count <= 0xffffffff, 'Gift quantity overflow', ErrorCode.InvalidArgument)
        // Unique resources must keep individual reward instances.
        if ([1, 5, 9, 14, 17, 25, 26, 30, 33, 37, 40].includes(type))
            return Array.from({ length: request.num }, () => ({ ...selected[0] }))
        return [{ ...selected[0], itemnum: count }]
    }
    ensure(!request.args?.length, 'This gift does not accept choices', ErrorCode.UseItemArgFail)
    const dropId = Number(item.useFunction)
    ensure(Number.isSafeInteger(dropId) && dropId > 0, 'Gift drop configuration is missing', ErrorCode.GameConfig)
    if (!catalogs.has(tables)) catalogs.set(tables, new WorldObjectCatalog(tables))
    const catalog = catalogs.get(tables),
        rewards = [],
        budget = { count: 0 }
    // Reuse the table-driven drop-group/weight/range evaluator. Each box is
    // an independent draw; multiplying one random draw would correlate rolls.
    for (let index = 0; index < request.num; index++) rewards.push(...catalog.drops(dropId, randomInt, budget))
    return rewards
}
