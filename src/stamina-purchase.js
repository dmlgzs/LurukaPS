import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { prepareStamina, finishStamina } from './stamina.js'
import { spendCurrency } from './inventory.js'
import { grantRewards } from './rewards.js'

const catalogues = new WeakMap()
function catalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const rows = [...tables.get('stamina')].sort((a, b) => a.id - b.id)
    ensure(rows.length > 0, 'Missing stamina purchase configuration', ErrorCode.GameConfig)
    const purchases = rows.map((row, index) => {
        const price = String(row.price).split('|').map(Number)
        ensure(
            row.id === index + 1 &&
                Number.isSafeInteger(row.stamina) &&
                row.stamina > 0 &&
                price.length === 3 &&
                price.every((n) => Number.isSafeInteger(n) && n > 0),
            'Invalid stamina purchase row',
            ErrorCode.GameConfig,
        )
        return { ...row, price }
    })
    const game = tables.get('game'),
        enabled = Number(game.find((r) => r.title === 'STAMINA_SWITCH')?.value)
    const gameLimit = Number(game.find((r) => r.title === 'STAMINA_LIMIT')?.value),
        currencyLimit = tables.find('currency', 3)?.maxNum
    ensure(
        [0, 1].includes(enabled) &&
            Number.isSafeInteger(gameLimit) &&
            gameLimit >= 0 &&
            Number.isSafeInteger(currencyLimit) &&
            currencyLimit >= 0,
        'Invalid stamina purchase limits',
        ErrorCode.GameConfig,
    )
    const limit =
        gameLimit > 0 && currencyLimit > 0 ? Math.min(gameLimit, currencyLimit) : Math.max(gameLimit, currencyLimit)
    ensure(limit > 0 && limit <= 0x7fffffff, 'Missing stamina purchase capacity', ErrorCode.GameConfig)
    const result = { purchases, enabled, limit }
    catalogues.set(tables, result)
    return result
}

function hasPaidCurrencyDebt(state) {
    // Private persistence envelope for an imported/authoritative DebtPackInfo.
    // This guard does not fabricate a refund or a debt repayment producer.
    if (state.mallDebtPack === undefined) return false
    const rows = state.mallDebtPack?.debt_list
    ensure(Array.isArray(rows), 'Malformed currency debt pack', ErrorCode.GameConfig)
    let owed = false
    for (const row of rows) {
        ensure(
            Number.isSafeInteger(row.item_type) &&
                row.item_type > 0 &&
                Number.isSafeInteger(row.item_id) &&
                row.item_id > 0 &&
                /^\d+$/.test(String(row.item_debt ?? '0')) &&
                (typeof row.item_debt !== 'number' || Number.isSafeInteger(row.item_debt)) &&
                BigInt(row.item_debt ?? 0) <= 0xffffffffffffffffn,
            'Malformed currency debt entry',
            ErrorCode.GameConfig,
        )
        if ([1, 901, 902].includes(row.item_id) && BigInt(row.item_debt ?? 0) > 0n) owed = true
    }
    return owed
}

export function buyStamina(c) {
    prepareStamina(c.tables, c.state, c.now)
    const model = catalogue(c.tables)
    ensure(model.enabled === 1, 'Stamina purchase is disabled', ErrorCode.BuyStaminaClose)
    const attrs = c.state.player.attr_infos.attrs
    const count = Number(attrs.find((a) => a.attr_id === 200031).attr_val),
        current = Number(attrs.find((a) => a.attr_id === 3).attr_val)
    ensure(
        count < model.purchases.length,
        'Stamina purchase count reached the configured maximum',
        ErrorCode.BuyStamina,
    )
    const row = model.purchases[count]
    ensure(
        current + row.stamina <= model.limit,
        'Stamina purchase exceeds the configured capacity',
        ErrorCode.StaminaIsMax,
    )
    ensure(
        !hasPaidCurrencyDebt(c.state),
        'Stamina purchase with currency debt requires repayment support',
        ErrorCode.FunctionClosed,
    )
    const [type, id, amount] = row.price
    ensure(type === 10, 'Stamina purchase cost type is not implemented', ErrorCode.FunctionClosed)
    if ([1, 2].includes(id))
        ensure(
            Number.isSafeInteger(c.state.player.basic_info[id === 1 ? 'diamond' : 'gold']) &&
                c.state.player.basic_info[id === 1 ? 'diamond' : 'gold'] >= 0,
            'Malformed stamina purchase wallet',
            ErrorCode.GameConfig,
        )
    spendCurrency(c.state, id, amount)
    grantRewards(c.tables, c.state, [{ itemtype: 10, itemid: 3, itemnum: row.stamina }])
    attrs.find((a) => a.attr_id === 200031).attr_val = String(count + 1)
    attrs.find((a) => a.attr_id === 200029).attr_val = String(Math.floor(c.now))
    finishStamina(c.tables, c.state, c.now)
    // Native success callback owns the acquisition page. Game publishes the
    // wallet and attribute delta before this ProtoNullRsp acknowledgement.
    return {}
}
