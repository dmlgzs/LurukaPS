import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { spend, spendCurrency } from './inventory.js'
import { grantRewards, parseRewards } from './rewards.js'

const uint = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff
function product(a, b) {
    const n = a * b
    ensure(uint(n), 'Gacha exchange amount overflow', ErrorCode.GameConfig)
    return n
}
function origin(tables, type, id) {
    const rows = tables.get('common_item_change').flatMap((row) => {
        const output = parseRewards(row.change)
        return output.some((item) => item.itemtype === type && item.itemid === id) ? [{ row, output }] : []
    })
    ensure(rows.length === 1, 'Gacha exchange origin is missing or ambiguous', ErrorCode.GameConfig)
    const { row, output } = rows[0]
    ensure(
        uint(row.itemId) && uint(row.itemNum) && output.length === 1 && uint(output[0].itemnum),
        'Invalid gacha exchange recipe',
        ErrorCode.GameConfig,
    )
    ensure(row.itemType === 10, 'Gacha exchange input category not implemented', ErrorCode.FunctionClosed)
    return { row, output: output[0] }
}
function currency(state, id) {
    if (id === 1 || id === 2) {
        const n = state.player.basic_info[id === 1 ? 'diamond' : 'gold']
        ensure(Number.isSafeInteger(n) && n >= 0, 'Invalid gacha currency balance', ErrorCode.GameConfig)
        return BigInt(n)
    }
    const text = String(state.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? '0')
    ensure(/^\d+$/.test(text), 'Invalid gacha currency balance', ErrorCode.GameConfig)
    return BigInt(text)
}

// ModuleGachaPool.CheckGachaEnough confirms the exchange and directly sends
// 9701. It never sends 6032 first. Pay only the ticket shortage, atomically with
// the draw; no independent purchase transaction or extra reward presentation.
export function payGachaTickets(c, tables, ticketId, fee) {
    if (!fee) return
    const available = c.state.player.sbag_infos.items
        .filter((item) => item.itemid === ticketId && (!item.deadtime || item.deadtime > c.now))
        .reduce((n, item) => n + item.itemnum, 0)
    ensure(Number.isSafeInteger(available) && available >= 0, 'Invalid gacha ticket balance', ErrorCode.GameConfig)
    if (available < fee) {
        const ticket = origin(tables, 3, ticketId)
        const batches = Math.ceil((fee - available) / ticket.output.itemnum)
        const cost = product(ticket.row.itemNum, batches)
        const held = currency(c.state, ticket.row.itemId)
        if (held < BigInt(cost)) {
            const fallback = origin(tables, 10, ticket.row.itemId)
            const exchanges = Math.ceil(Number(BigInt(cost) - held) / fallback.output.itemnum)
            const inputCost = product(fallback.row.itemNum, exchanges)
            // CBT3 GetCurrencyNum displays 901+902 as one wallet. Bonus first
            // matches the existing local mall policy; official order is TODO.
            if (fallback.row.itemId === 901 || fallback.row.itemId === 902) {
                const bonus = currency(c.state, 902),
                    paid = currency(c.state, 901)
                ensure(bonus + paid >= BigInt(inputCost), 'Insufficient gacha currency', ErrorCode.ItemNotEnough)
                const bonusCost = Number(bonus < BigInt(inputCost) ? bonus : BigInt(inputCost))
                if (bonusCost) spendCurrency(c.state, 902, bonusCost)
                if (inputCost > bonusCost) spendCurrency(c.state, 901, inputCost - bonusCost)
            } else spendCurrency(c.state, fallback.row.itemId, inputCost)
            grantRewards(tables, c.state, [
                { ...fallback.output, itemnum: product(fallback.output.itemnum, exchanges) },
            ])
        }
        spendCurrency(c.state, ticket.row.itemId, cost)
        grantRewards(tables, c.state, [{ ...ticket.output, itemnum: product(ticket.output.itemnum, batches) }])
    }
    spend(c.state, new Map([[ticketId, fee]]), 0, c.now)
}
