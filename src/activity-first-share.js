import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards } from './rewards.js'
import { WorldObjectCatalog } from './world-objects.js'

const positive = (v) => Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff
// Current pagePhotoPreview maps Photo/Activity/Gacha to 1/3/4. The protocol
// description also names video2, but no distinct current sender was recovered.
const sources = new Set([1, 3, 4])
function claim(state) {
    const value = state.firstShareReward
    if (value === undefined) return null
    ensure(
        value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            value.version === 1 &&
            sources.has(value.type) &&
            positive(value.time),
        'Malformed first-share claim',
        ErrorCode.GameConfig,
    )
    return value
}
export function firstShareSnapshot(state) {
    // Current GameEventStore and ShareManager consume a single global scalar:
    // zero means available; a nonzero first content type means already claimed.
    return { share_first_reward_type: claim(state)?.type ?? 0 }
}
export function claimFirstShare(c, type) {
    ensure(positive(type) && type <= 4, 'Unknown first-share content type', ErrorCode.InvalidArgument)
    ensure(sources.has(type), 'First-share video source is not implemented', ErrorCode.FunctionClosed)
    const previous = claim(c.state)
    if (previous) {
        c.pushBefore('CSProtoShareFirstRewardSync', firstShareSnapshot(c.state))
        return { rewards: [] }
    }
    const rows = c.tables.get('share_reward')
    const row = rows.find((r) => r.rewardId === 1)
    ensure(row, 'First-share reward configuration missing', ErrorCode.ActivityRewardConfNone)
    ensure(
        rows.length === 1 && row.rewardType === 1,
        'First-share reward rules are not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(positive(row.shareDrop), 'Invalid first-share drop identity', ErrorCode.GameConfig)
    ensure(positive(c.now), 'Invalid first-share clock', ErrorCode.GameConfig)
    const items = new WorldObjectCatalog(c.tables).drops(row.shareDrop, c.randomInt)
    ensure(items.length > 0, 'First-share reward pool is empty', ErrorCode.ActivityRewardConfNone)
    const rewards = grantRewards(c.tables, c.state, items)
    // LOCAL durable representation. The public PC save callback submits only
    // its content type, without an external social account or verification token.
    c.state.firstShareReward = { version: 1, type, time: c.now }
    c.pushBefore('CSProtoSyncPlayerData', {
        basic_info: c.state.player.basic_info,
        attr_infos: c.state.player.attr_infos,
        sbag_infos: c.state.player.sbag_infos,
    })
    c.pushBefore('CSProtoShareFirstRewardSync', firstShareSnapshot(c.state))
    return { rewards }
}
export function registerFirstShare(on) {
    on('ShareFirstReward', (c, request) => claimFirstShare(c, request.u32))
}
