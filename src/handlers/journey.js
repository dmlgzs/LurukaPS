import { claimJourney } from '../journey.js'
import { setJourneyTrace } from '../journey-trace.js'

export function registerJourney(on) {
    on('JourneyTaskFinish', claimJourney)
    on('JourneyClientTrace', setJourneyTrace)
}
