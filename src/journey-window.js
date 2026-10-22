import { journeyLedger, publishJourney } from './journey.js'

export function acknowledgeJourneyWindow(c) {
    journeyLedger(c.state).windowShow = 1
    publishJourney(c)
    return {}
}
