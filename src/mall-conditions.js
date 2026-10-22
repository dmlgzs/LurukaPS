import { cosmeticOwnedCount } from './appearance-rewards.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function mallConditions(tables, state, text) {
    const ids = [],
        progress = [],
        checks = []
    let supported = true
    for (const token of String(text ?? '')
        .split('|')
        .filter(Boolean)) {
        const parts = token.split('#').map(Number),
            [kind, a, b, count] = parts
        ensure(
            parts.every((n) => Number.isSafeInteger(n) && n >= 0) && kind > 0,
            'Invalid mall condition',
            ErrorCode.MallConfigError,
        )
        ids.push(kind)
        let value = 0,
            known = true,
            passed = false
        if (kind === 2004 && parts.length === 2 && a > 0) {
            value = state.player.basic_info.lv
            passed = value >= a
        } else if (kind === 2007 && parts.length === 2 && a > 0) {
            value = (state.taskRecords ?? []).some((r) => r.task_id === a && r.count > 0) ? a : 0
            passed = value >= a
        } else if (kind === 12081 && parts.length === 4 && a > 0 && b > 0) {
            // HaveItemCond.OnCheckCond uses exact equality, including zero.
            const owned = cosmeticOwnedCount(tables, state, a, b)
            known = owned !== null
            value = owned ?? 0
            passed = known && value === count
        } else known = false
        supported &&= known
        progress.push(value)
        checks.push(passed)
    }
    return { ids, progress, passed: checks.every(Boolean), supported }
}
