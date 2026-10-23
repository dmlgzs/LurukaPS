import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Only the explicitly configured local campaign mode opts into this ledger.
// Wire requests have no attempt nonce: serial Start -> Step -> Finish is the
// boundary. A delayed old Finish cannot be authenticated across a new valid Step.
export function campaignPlayableContext(state, playId, { finishing = false } = {}) {
    const campaign = state.storyCampaign
    if (!campaign?.local_playable_condition) return null
    ensure(
        campaign.map_id === state.world.map_id &&
            (campaign.status === 2 || (finishing && campaign.status === 3)),
        'Campaign playable is not active in this scene', ErrorCode.EntrustMapInvalid,
    )
    ensure(Number.isSafeInteger(campaign.instance_id) && campaign.instance_id > 0,
        'Campaign playable instance is missing; quit and re-enter', ErrorCode.InvalidLogic)
    ensure(campaign.playable_ids?.includes(playId), 'Playable does not belong to this campaign', ErrorCode.ParamError)
    return campaign
}

function preserveClaims(state, id, finish) {
    if (finish?.reward_info !== undefined)
        (state.playableScoreClaims ??= {})[id] = Number(BigInt(state.playableScoreClaims?.[id] ?? 0) | BigInt(finish.reward_info))
}

export function prepareCampaignPlayableStart(state, playId) {
    const campaign = campaignPlayableContext(state, playId)
    if (!campaign) return null
    const run = state.playableRuns?.[playId], finish = state.playableFinishes?.[playId]
    // A legacy run without an epoch is never upgraded into authenticated success.
    if (run && run.campaign_instance_id !== campaign.instance_id) delete state.playableRuns[playId]
    if (finish && finish.campaign_instance_id !== campaign.instance_id) {
        preserveClaims(state, playId, finish)
        delete state.playableFinishes[playId]
    }
    return campaign
}

export function bindCampaignPlayableStart(state, run, campaign) {
    if (!campaign) return
    campaign.next_playable_attempt = (campaign.next_playable_attempt ?? 0) + 1
    ensure(Number.isSafeInteger(campaign.next_playable_attempt), 'Campaign playable attempt overflow', ErrorCode.GameConfig)
    run.campaign_instance_id = campaign.instance_id
    run.campaign_attempt_id = campaign.next_playable_attempt
}

export function requireCampaignPlayableRun(state, playId, run, options) {
    const campaign = campaignPlayableContext(state, playId, options)
    if (!campaign) return null
    ensure(run?.campaign_instance_id === campaign.instance_id && Number.isSafeInteger(run.campaign_attempt_id) && run.campaign_attempt_id > 0,
        'Playable run is not from the current campaign instance', ErrorCode.InvalidLogic)
    return campaign
}

export function acceptCampaignPlayableFinish(state, playId, run, finish) {
    const campaign = requireCampaignPlayableRun(state, playId, run, { finishing: true })
    if (!campaign) return false
    ensure(finish?.campaign_instance_id === campaign.instance_id && finish.campaign_attempt_id === run.campaign_attempt_id,
        'Playable finish is not from the current attempt', ErrorCode.InvalidLogic)
    const receipts = (campaign.playable_successes ??= {})
    if (receipts[playId]) return false
    receipts[playId] = { instance_id: campaign.instance_id, attempt_id: run.campaign_attempt_id, map_id: run.map_id, play_id: playId }
    return true
}

export function clearCampaignPlayables(state, campaign) {
    if (!campaign?.local_playable_condition) return false
    for (const id of campaign.playable_ids ?? []) {
        const run = state.playableRuns?.[id], finish = state.playableFinishes?.[id]
        if (run?.campaign_instance_id === campaign.instance_id) delete state.playableRuns[id]
        if (finish?.campaign_instance_id === campaign.instance_id) {
            preserveClaims(state, id, finish)
            delete state.playableFinishes[id]
        }
    }
    return true
}

export function playableWire(run) {
    const { map_id, selected_step, selected_pet_group, selected_pet_guid, rewarded_steps,
        prior_reward_info, campaign_instance_id, campaign_attempt_id, ...wire } = run
    return wire
}
