import { ErrorCode } from '../error-codes.js'
import { rewardSource } from '../reward-source.js'
import { ensure, syncPlayer } from './common.js'
import { grantRewards, parseRewards } from '../rewards.js'

export function registerExplorationRewards(on) {
    on('WorldMapExploreReward', (c, r) => {
        const rows = c.tables.get('explore_map_reward').filter((x) => x.mapId === r.u32)
        ensure(c.tables.find('world_city', r.u32), 'Unknown exploration map', ErrorCode.GameConfig)
        ensure(rows.length, 'Exploration rewards configuration unavailable', ErrorCode.GameConfig)
        const entry = c.state.exploration?.map_info?.find((x) => x.map_id === r.u32)
        ensure(entry, 'Exploration progress unavailable', ErrorCode.ExplorationMapIdInvilid)
        entry.rewards ??= []
        ensure(
            Number.isInteger(entry.lv) &&
                entry.lv >= 0 &&
                Array.isArray(entry.rewards) &&
                entry.rewards.every((id) => Number.isInteger(id) && id > 0),
            'Invalid exploration progress',
            ErrorCode.GameConfig,
        )
        ensure(
            rows.every(
                (row) =>
                    Number.isInteger(row.id) &&
                    row.id > 0 &&
                    Number.isInteger(row.exploreLevel) &&
                    row.exploreLevel > 0,
            ) && new Set(rows.map((row) => row.id)).size === rows.length,
            'Invalid exploration reward tiers',
            ErrorCode.GameConfig,
        )
        // WorldExploreStore passes only a map ID: claim every achieved tier.
        const fresh = rows.filter((x) => x.exploreLevel <= entry.lv && !entry.rewards.includes(x.id))
        const rewards = grantRewards(
            c.tables,
            c.state,
            fresh.flatMap((x) => parseRewards(x.reward)),
        )
        entry.rewards.push(...fresh.map((x) => x.id))
        if (fresh.length) syncPlayer({ ...c, push: c.pushBefore })
        c.pushBefore('CSProtoWorldExplorationSync', { map_info: [entry], mission_info: [], login: false })
        return { rewards, ...(rewards.length ? { src: rewardSource(c.tables, 'explorationReward') } : {}) }
    })
}
