import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { guidedConditionValue } from './guided-conditions.js'
import { journeyModel, journeyLedger, journeyUnlocked, observeJourney, publishJourney } from './journey.js'

export function setJourneyTrace(c, r) {
    const model = journeyModel(c.tables),
        ledger = journeyLedger(c.state),
        // CSJourneyTrace is proto2: absent journey_id/is_trace mean 0/false.
        // The client can omit false on the wire; decode deliberately preserves
        // field presence for other protocols, so apply these defaults locally.
        journeyId = r.journey_id === undefined ? 0 : r.journey_id,
        isTrace = r.is_trace === undefined ? false : r.is_trace
    ensure(
        Number.isSafeInteger(journeyId) && journeyId >= 0 && typeof isTrace === 'boolean',
        'Invalid journey trace request',
        ErrorCode.InvalidArgument,
    )
    if (!isTrace) {
        // A stale cancel must not cancel a more recently selected card.
        if (!journeyId || journeyId === ledger.traceId) ledger.traceId = 0
        publishJourney(c)
        return {}
    }
    const target = model.byTarget.get(journeyId),
        owner = model.byTask.get(model.owner.get(journeyId))
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
