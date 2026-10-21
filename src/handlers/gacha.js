import { GachaCatalog } from '../gacha.js'
import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'
import { gachaTables } from '../gacha-tables.js'
import { gachaHistoryPage } from '../gacha-history.js'

export function registerGacha(on, tables) {
    tables = gachaTables(tables)
    // Loaded on first request: an unrelated login need not parse the entire gacha catalog.
    let catalog
    const data = () => (catalog ??= new GachaCatalog(tables))
    on('GachaHistory', (c, r) => {
        c.pushBefore('CSProtoGachaHistoryNtf', gachaHistoryPage(data(), c.state, r))
        return {}
    })
    on('GachaAimTarget', (c, r) => {
        const config = data().configuration(r.pool_id)
        const allowed = parseRewards(config.selfChooseuplist)
        ensure(allowed.length, 'This gacha pool does not offer an aimed target', ErrorCode.FunctionClosed)
        ensure(
            allowed.every((row) => [1, 9].includes(row.itemtype) && row.itemnum === 1),
            'Invalid gacha target list',
            ErrorCode.GameConfig,
        )
        ensure(
            allowed.every((row) => tables.find(row.itemtype === 1 ? 'hero' : 'soulessence', row.itemid)),
            'Gacha target references an unavailable item',
            ErrorCode.GameConfig,
        )
        ensure(
            !r.item_id || allowed.some((row) => row.itemid === r.item_id),
            'Gacha target is not offered by this pool',
        )
        data().snapshot(c.state, config.gachaId)
        const pool = data().state(c.state, config).gacha_pool
        // Setting a target is not drawing, claiming or spending a resource.
        // No table field specifies a reset of the ordinary pity counters here.
        pool.aimed_item_ids = r.item_id ? [r.item_id] : []
        return { gacha_pool: data().snapshot(c.state, config.gachaId).gacha_pool }
    })
    const claimCumulative = (c, id, spec) => {
        const catalog = data(),
            config = catalog.configuration(id),
            group = config[spec.group]
        ensure(group, 'Gacha reward feature is not enabled for this pool', ErrorCode.FunctionClosed)
        const rows = tables
            .get(spec.table)
            .filter((row) => row[spec.groupKey] === group)
            .sort((a, b) => a[spec.order] - b[spec.order])
        ensure(
            rows.length &&
                rows.every(
                    (row) =>
                        Number.isInteger(row[spec.order]) &&
                        row[spec.order] > 0 &&
                        Number.isInteger(row[spec.threshold]) &&
                        row[spec.threshold] > 0,
                ) &&
                new Set(rows.map((row) => row[spec.order])).size === rows.length &&
                rows.every((row, index) => !index || row[spec.threshold] >= rows[index - 1][spec.threshold]),
            'Invalid cumulative gacha rewards configuration',
            ErrorCode.GameConfig,
        )
        catalog.snapshot(c.state, id)
        const entry = catalog.state(c.state, config),
            pool = entry.gacha_pool
        const fresh = rows.filter(
            (row) => row[spec.order] > pool[spec.receipt] && row[spec.threshold] <= pool[spec.progress],
        )
        const rewards = grantRewards(
            tables,
            c.state,
            fresh.flatMap((row) => parseRewards(row.reward)),
        )
        if (fresh.length) pool[spec.receipt] = fresh.at(-1)[spec.order]
        return {
            rewards: { rewards, ...(rewards.length ? { src: rewardSource(tables, spec.source) } : {}) },
            gachaPool: catalog.snapshot(c.state, id).gacha_pool,
        }
    }
    on('GachaStep', (c, r) =>
        claimCumulative(c, r.u32, {
            group: 'stepId',
            table: 'gacha_step',
            groupKey: 'stepId',
            order: 'stepStage',
            threshold: 'stepCount',
            receipt: 'received_stage_count',
            progress: 'pool_draw_count',
            source: 'gachaStageReward',
        }),
    )
    on('GachaUp', (c, r) =>
        claimCumulative(c, r.u32, {
            group: 'upReward',
            table: 'gacha_up_reward',
            groupKey: 'upRewardId',
            order: 'upCount',
            threshold: 'upCount',
            receipt: 'received_up_count',
            progress: 'draw_up_hero_count',
            source: 'gachaUpReward',
        }),
    )
    on('GachaData', (c) => ({
        // This is progress data, not permission to draw in a closed banner.
        gacha_pools: [...data().pools.keys()].map((id) => data().snapshot(c.state, id)),
    }))
}
