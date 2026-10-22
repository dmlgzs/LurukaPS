import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { spendCurrency } from './inventory.js'

export function hasPaidCurrencyDebt(state) {
    // This is the existing imported DebtPackInfo envelope, not a refund producer.
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

export function spendPaidCurrency(state, amount) {
    ensure(
        Number.isSafeInteger(amount) && amount > 0 && amount <= 0xffffffff,
        'Invalid paid diamond cost',
        ErrorCode.MallConfigError,
    )
    ensure(!hasPaidCurrencyDebt(state), 'Paid currency debt requires repayment support', ErrorCode.FunctionClosed)
    const balance = (id) => {
        const raw = state.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? '0'
        ensure(
            /^\d+$/.test(String(raw)) && (typeof raw !== 'number' || Number.isSafeInteger(raw)),
            'Invalid paid currency balance',
            ErrorCode.GameConfig,
        )
        const n = BigInt(raw)
        ensure(n <= 0xffffffffffffffffn, 'Invalid paid currency balance', ErrorCode.GameConfig)
        return n
    }
    const paid = balance(901),
        bonus = balance(902)
    // MyPlayerData.GetCurrencyNum(901/902) displays their sum. Bonus-first
    // debiting is the existing documented local policy, not an official claim.
    ensure(paid + bonus >= BigInt(amount), 'Insufficient paid currency', ErrorCode.ItemNotEnough)
    const bonusCost = Number(bonus < BigInt(amount) ? bonus : BigInt(amount))
    if (bonusCost) spendCurrency(state, 902, bonusCost)
    if (amount > bonusCost) spendCurrency(state, 901, amount - bonusCost)
}
