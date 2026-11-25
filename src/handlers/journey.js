import { claimJourney } from '../journey.js'
import { setJourneyTrace } from '../journey-trace.js'
import { claimJourneyPointRewards } from '../journey-point-rewards.js'
import { claimJourneySpecialReward } from '../journey-special-reward.js'
import { acknowledgeJourneyWindow } from '../journey-window.js'

export function registerJourney(on, { legacyWindow = true } = {}) {
    on('JourneyTaskFinish', claimJourney)
    on('JourneyClientTrace', setJourneyTrace)
    on('JourneyReceivePointReward', claimJourneyPointRewards)
    on('JourneyReceiveSpecialReward', claimJourneySpecialReward)
    if (legacyWindow) on('ShowJourneyStageWindow', acknowledgeJourneyWindow)
}
