import { ErrorCode } from './error-codes.js'
import { worldCondition } from './handlers/world-objects.js'

export function worldSearchVisible(row, record, state, { ignoreCompletion = false } = {}) {
    if (record?.active === false || (record?.active === undefined && row.initStatus === 1)) return false
    if (!ignoreCompletion && (record?.complete ?? !!row.initialCompleteState)) return false
    try {
        return (
            worldCondition(row.appearCond, state) && (!row.disappearCond || !worldCondition(row.disappearCond, state))
        )
    } catch (error) {
        // An unimplemented appearance rule must not reveal a hidden target.
        if (![ErrorCode.GameConfig, ErrorCode.FunctionClosed].includes(error.code)) throw error
        return false
    }
}
