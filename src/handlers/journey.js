import { claimJourney } from '../journey.js'

export function registerJourney(on) {
    on('JourneyTaskFinish', claimJourney)
}
