import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards } from './rewards.js'
import { WorldObjectCatalog } from './world-objects.js'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
function ids(value, message) {
    const rows = String(value ?? '')
        .split('|')
        .map(Number)
    ensure(rows.length > 0 && rows.every(positive) && new Set(rows).size === rows.length, message, ErrorCode.GameConfig)
    return rows
}
function definition(tables, row) {
    const group = tables.find('game_events_follow_group', row.systemId)
    ensure(group, 'Follow activity configuration is missing', ErrorCode.ActivityExConfNone)
    const members = ids(group.showType, 'Invalid follow activity membership')
    const rewards = ids(group.followReward, 'Invalid follow reward membership')
    // Current ModuleActivityFollow exposes type 2 and reward[0]. Other SDK/type
    // contracts are not recovered; do not reinterpret an arbitrary ID as proof.
    ensure(rewards.length === 1, 'Follow reward mapping is not implemented', ErrorCode.FunctionClosed)
    const reward = tables.find('game_events_reward', rewards[0])
    ensure(
        reward && reward.groupId === row.id,
        'Follow reward configuration is missing',
        ErrorCode.ActivityRewardConfNone,
    )
    ensure(
        !reward.finishCondition && !reward.reward,
        'Additional follow reward rules are not implemented',
        ErrorCode.FunctionClosed,
    )
    const pools = ids(reward.dropId, 'Invalid follow reward drop definition')
    return { members, pools }
}
function ledger(entry) {
    const data =
        entry.follow === undefined ? { claimed_click_ids: [], claimed_sdk_ids: [], claimed_types: [] } : entry.follow
    ensure(data && typeof data === 'object' && !Array.isArray(data), 'Invalid follow progress', ErrorCode.GameConfig)
    for (const name of ['claimed_click_ids', 'claimed_sdk_ids', 'claimed_types']) {
        const values = data[name]
        ensure(
            Array.isArray(values) && values.every(positive) && new Set(values).size === values.length,
            'Invalid follow claim ledger',
            ErrorCode.GameConfig,
        )
    }
    return data
}
export function followActivitySnapshot(tables, entry, row) {
    definition(tables, row)
    return structuredClone(ledger(entry))
}
export function claimActivityFollow(c, catalog, request) {
    const config = catalog.rows.find((row) => row.id === request.activity_id)
    ensure(config, 'Unknown follow activity', ErrorCode.ActivityNotFond)
    ensure(config.type === 150, 'Activity is not a follow activity', ErrorCode.ActivityTypeNotEqual)
    const model = definition(c.tables, config)
    const follow = c.tables.find('game_events_follow', request.follow_id)
    ensure(
        positive(request.follow_id) && model.members.includes(request.follow_id) && follow,
        'Follow entry does not belong to activity',
        ErrorCode.ActivityFollowInvalidId,
    )
    ensure(follow.type === 2, 'Follow entry type is not implemented', ErrorCode.FunctionClosed)
    const { entry } = catalog.require(c.state, c.now, config.id, [150])
    const progress = ledger(entry)
    ensure(
        !progress.claimed_types.includes(follow.type),
        'Follow reward was already claimed',
        ErrorCode.ActivityFollowAlreadyClaimed,
    )
    const drops = new WorldObjectCatalog(c.tables)
    const items = model.pools.flatMap((pool) => drops.drops(pool, c.randomInt))
    ensure(items.length > 0, 'Follow reward pool is empty', ErrorCode.ActivityRewardConfNone)
    const granted = grantRewards(c.tables, c.state, items)
    // LOCAL save representation of the native type-level claim contract. The
    // public sender supplies no external-account verification or SDK token.
    entry.follow = { ...progress, claimed_types: [...progress.claimed_types, follow.type] }
    c.pushBefore('CSProtoSyncPlayerData', {
        basic_info: c.state.player.basic_info,
        sbag_infos: c.state.player.sbag_infos,
        attr_infos: c.state.player.attr_infos,
        heros_info: c.state.player.heros_info,
    })
    catalog.notify(c, true)
    return { rewards: granted }
}
