import { ErrorCode } from './error-codes.js'

const warned = new Set()
// This adapter is deliberately independent of tracking/enemy state. Callers
// supply their existing predicate, avoiding a new combat-module dependency cycle.
export function trackingConditionResult(evaluate, expression, context) {
    try {
        return evaluate()
    } catch (error) {
        if (error.code !== ErrorCode.FunctionClosed) throw error
        const key = String(expression)
        if (!warned.has(key)) {
            warned.add(key)
            if (warned.size > 1024) warned.delete(warned.values().next().value)
            console.warn(
                '[pet-tracking] ' +
                    JSON.stringify({ event: 'unsupported-condition', code: error.code, expression: key, ...context }),
            )
        }
        // Unknown is distinct from a proven false predicate: callers must also
        // hide an unknown disappear rule or random-pool branch.
        return undefined
    }
}
