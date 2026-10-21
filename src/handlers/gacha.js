import { GachaCatalog } from '../gacha.js'
import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'

export function registerGacha(on, tables) {
    // Loaded on first request: an unrelated login need not parse the entire gacha catalog.
    let catalog
    const data = () => (catalog ??= new GachaCatalog(tables))
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
    on('GachaData', (c) => ({
        // This is progress data, not permission to draw in a closed banner.
        gacha_pools: [...data().pools.keys()].map((id) => data().snapshot(c.state, id)),
    }))
}
