import { claimJourney } from '../journey.js'
import { setJourneyTrace } from '../journey-trace.js'
import { claimJourneyPointRewards } from '../journey-point-rewards.js'
import { claimJourneySpecialReward } from '../journey-special-reward.js'

export function registerJourney(on) {
    on('JourneyTaskFinish', claimJourney)
    on('JourneyClientTrace', setJourneyTrace)
    on('JourneyReceivePointReward', claimJourneyPointRewards)
    on('JourneyReceiveSpecialReward', claimJourneySpecialReward)
}
