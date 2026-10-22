import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { aggregateCosts, spend, spendCurrency } from '../inventory.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { detectorTarget, consumeDetector } from '../world-detectors.js'
function safeProduct(a, b) {
    const n = a * b
    ensure(Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff, 'Item count overflow')
    return n
}
export function registerItems(on) {
    const stamina = (c, items) => {
        const costs = aggregateCosts(items.map((i) => ({ item_id: i.itemid, item_num: i.num })))
        let gain = 0,
            unit
        for (const item of items) ensure(!item.args?.length, 'Unsupported item arguments')
        for (const [id, count] of costs) {
            const config = c.tables.find('common_item', id)
            ensure(config?.type === 100, 'This consumable type is not implemented', ErrorCode.InvalidProtoID)
            const value = Number(String(config.useFunction).split('|')[0])
            ensure(Number.isSafeInteger(value) && value > 0, 'Invalid stamina item', ErrorCode.GameConfig)
            ensure(unit === undefined || unit === value, 'Mixed stamina denominations require separate use')
            unit = value
            gain += safeProduct(value, count)
            ensure(Number.isSafeInteger(gain) && gain <= 0xffffffff, 'Stamina gain overflow')
        }
        const cap = Number(c.tables.get('game').find((x) => x.title === 'STAMINA_LIMIT')?.value)
        ensure(Number.isSafeInteger(cap) && cap > 0, 'Invalid stamina cap', ErrorCode.GameConfig)
        const current = BigInt(c.state.player.attr_infos.attrs.find((a) => a.attr_id === 3)?.attr_val || 0)
        ensure(current < BigInt(cap), 'Stamina is at the use limit')
        ensure(gain <= Math.ceil((cap - Number(current)) / unit) * unit, 'Too many stamina items selected')
        spend(c.state, costs, 0, c.now)
        const rewards = grantRewards(c.tables, c.state, [{ itemtype: 10, itemid: 3, itemnum: gain }])
        syncPlayer(c)
        return { rewards }
    }
    on('UseItem', (c, r) => {
        if (c.tables.find('common_item', r.itemid)?.useType !== 18) return stamina(c, [r])
        ensure(r.num === 1 && !r.args?.length, 'Detector use requires one item and no arguments', ErrorCode.ParamError)
        const target = detectorTarget(c.tables, c.state, r.itemid, c.now)
        ensure(target > 0, 'No incomplete detector target is available', ErrorCode.ParamError)
        consumeDetector(c, r.itemid)
        // Local MapObjectDetect already knows its target. Its UseItem callback
        // expects Rewards and reuses that cached ID, not an 11075 response.
        return { rewards: [] }
    })
    on('BatchUseItem', (c, r) => {
        ensure(r.items.length > 0 && r.items.length <= 100, 'Invalid use batch')
        return stamina(c, r.items)
    })
    on('ExchangeItem', (c, r) => {
        ensure(Number.isInteger(r.item_num) && r.item_num > 0, 'Invalid exchange quantity')
        ensure(!r.args?.length, 'Exchange arguments are not yet supported', ErrorCode.InvalidProtoID)
        const recipes = c.tables
            .get('common_item_change')
            .filter((x) => x.itemId === r.item_id && x.itemType === r.item_type)
        ensure(recipes.length > 0, 'Unknown exchange recipe')
        ensure(
            recipes.length === 1,
            'Ambiguous exchange recipe requires verified selection semantics',
            ErrorCode.InvalidProtoID,
        )
        const recipe = recipes[0]
        ensure(Number.isSafeInteger(recipe.itemNum) && recipe.itemNum > 0, 'Invalid recipe cost', ErrorCode.GameConfig)
        const cost = safeProduct(recipe.itemNum, r.item_num)
        const configured = parseRewards(recipe.change)
        ensure(configured.length > 0, 'Recipe has no output', ErrorCode.GameConfig)
        const output = configured.map((x) => ({ ...x, itemnum: safeProduct(x.itemnum, r.item_num) }))
        if (r.item_type === 3) spend(c.state, new Map([[r.item_id, cost]]), 0, c.now)
        else if (r.item_type === 10) spendCurrency(c.state, r.item_id, cost)
        else ensure(false, 'Exchange source category is not implemented', ErrorCode.InvalidProtoID)
        const rewards = grantRewards(c.tables, c.state, output)
        syncPlayer(c)
        return { rewards }
    })
}
