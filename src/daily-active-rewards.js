import { activeCatalogue, ensureActivePeriods, notifyActive } from './daily-active.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { parseRewards, grantRewards } from './rewards.js'
import { mergeCollectionRewards } from './collection-claims.js'
import { rewardSource } from './reward-source.js'

const catalogues = new WeakMap()
function rewardsFor(tables, type) {
    if (!catalogues.has(tables)) {
        const all = tables.get('activity_reward')
        ensure(
            all.length > 0 &&
                new Set(all.map((r) => r.id)).size === all.length &&
                all.every(
                    (r) =>
                        Number.isSafeInteger(r.id) &&
                        r.id > 0 &&
                        [1, 2].includes(r.taskType) &&
                        Number.isSafeInteger(r.requireActivity) &&
                        r.requireActivity > 0,
                ),
            'Invalid active value reward table',
            ErrorCode.GameConfig,
        )
        const grouped = new Map()
        for (const kind of [1, 2]) {
            const rows = all.filter((r) => r.taskType === kind).sort((a, b) => a.requireActivity - b.requireActivity)
            ensure(
                rows.length && rows.every((r, i) => !i || r.requireActivity > rows[i - 1].requireActivity),
                'Invalid active value reward tiers',
                ErrorCode.GameConfig,
            )
            grouped.set(kind, rows)
        }
        catalogues.set(tables, grouped)
    }
    return catalogues.get(tables).get(type)
}
export function claimActiveValue(c, request) {
    const type = request.u32
    ensure([1, 2].includes(type), 'Invalid active reward category', ErrorCode.ActiveRewardTypeFail)
    const rows = rewardsFor(c.tables, type),
        name = type === 1 ? 'day' : 'week'
    const period = ensureActivePeriods(c.tables, c.state, c.now)[name],
        tasks = activeCatalogue(c.tables)
    ensure(
        new Set(period.claimed).size === period.claimed.length &&
            period.claimed.every((id) => tasks.byId.get(id)?.taskType === type),
        'Invalid saved active task receipts',
        ErrorCode.GameConfig,
    )
    const earned = period.claimed.reduce((sum, id) => sum + tasks.byId.get(id).reward, 0)
    ensure(earned === period.active, 'Saved active points do not match task receipts', ErrorCode.GameConfig)
    ensure(
        new Set(period.rewardIds).size === period.rewardIds.length &&
            period.rewardIds.every((id) => rows.some((r) => r.id === id)),
        'Invalid saved active value reward receipts',
        ErrorCode.GameConfig,
    )
    const eligible = rows.filter((r) => r.requireActivity <= period.active)
    ensure(eligible.length, 'Not enough active value', ErrorCode.ActiveValueNotEnough)
    const selected = eligible
        .filter((r) => !period.rewardIds.includes(r.id))
        .map((row) => ({ row, rewards: parseRewards(row.reward) }))
    const rewards = []
    for (const { rewards: items } of selected) rewards.push(...grantRewards(c.tables, c.state, items))
    if (selected.length)
        c.state.dailyActive = {
            ...c.state.dailyActive,
            [name]: {
                ...period,
                rewardIds: [...period.rewardIds, ...selected.map((s) => s.row.id)].sort((a, b) => a - b),
            },
        }
    notifyActive(c)
    return { rewards: mergeCollectionRewards(rewards), src: rewardSource(c.tables, 'dailyActiveValueReward') }
}
