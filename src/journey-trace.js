import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { guidedConditionValue } from './guided-conditions.js'
import { journeyModel, journeyLedger, journeyUnlocked, observeJourney, publishJourney } from './journey.js'

export function setJourneyTrace(c, r) {
    const model = journeyModel(c.tables),
        ledger = journeyLedger(c.state)
    ensure(
        Number.isSafeInteger(r.journey_id) && r.journey_id >= 0 && typeof r.is_trace === 'boolean',
        'Invalid journey trace request',
        ErrorCode.InvalidArgument,
    )
    if (!r.is_trace) {
        // A stale cancel must not cancel a more recently selected card.
        if (!r.journey_id || r.journey_id === ledger.traceId) ledger.traceId = 0
        publishJourney(c)
        return {}
    }
    const target = model.byTarget.get(r.journey_id),
        owner = model.byTask.get(model.owner.get(r.journey_id))
    ensure(target && owner, 'Unknown journey trace card', ErrorCode.JourneyTraceTargetLock)
    ensure(journeyUnlocked(model, c.state, owner), 'Journey trace card is locked', ErrorCode.JourneyTraceTargetLock)
    observeJourney(c.tables, c.state, [target.tokens[0]])
    ensure(!ledger.targets[target.id]?.complete, 'Journey trace card is complete', ErrorCode.JourneyTraceTargetFinish)
    for (const token of String(target.traceCondition || '')
        .split('|')
        .filter(Boolean)) {
        const values = token.split('#').map(Number)
        ensure(
            values.length === 3 && values[0] === 12027 && values.every(Number.isSafeInteger),
            'Journey trace prerequisite source not implemented',
            ErrorCode.FunctionClosed,
        )
        ensure(
            guidedConditionValue(0, c.state, undefined, { condition: values.join('|') }) >= values[2],
            'Journey trace prerequisite is unmet',
            ErrorCode.JourneyTraceTargetLock,
        )
    }
    ensure(ledger.traceId !== target.id, 'Journey card is already traced', ErrorCode.JourneyTraceIsSame)
    ledger.traceId = target.id
    publishJourney(c)
    return {}
}
