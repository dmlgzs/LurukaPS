import { registerKiboTours } from './kibo-tours.js'
import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { ActivityCatalog } from '../activities.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { WorldObjectCatalog } from '../world-objects.js'
import { spend, spendCurrency } from '../inventory.js'
import { rewardSource } from '../reward-source.js'
import { rollActivityRewardDrop } from '../activity-drop-currency.js'

export function registerActivities(on, tables, options = {}) {
    const catalog = new ActivityCatalog(tables, options),
        drops = new WorldObjectCatalog(tables)
    registerKiboTours(on, catalog)
    const activityTables = catalog.tables
    const publish = (c) => catalog.notify(c, true)
    const grant = (c, items) => {
        const rewards = grantRewards(tables, c.state, items)
        if (rewards.some((x) => x.itemtype === 1))
            c.pushBefore('CSProtoSyncPlayerData', { heros_info: c.state.player.heros_info })
        return rewards
    }
    on('ActivityGet', (c) => {
        // GlobalData's ending book is a separate client cache used by 80003/4/6.
        // Resend on explicit initialization even if this account synced before.
        catalog.syncGrowupHistory(c, true)
        for (const row of catalog.rows.filter((x) => x.type === 60)) {
            const entry = c.state.activities?.[row.id]
            if (entry?.growup?.cur_starting_id && catalog.active(row, c.state, c.now)) {
                catalog.growup.prepare(entry, row.systemId, c.randomInt)
                c.pushBefore('CSProtoSyncGrowupTrainAssistCharData', {
                    activity_id: row.id,
                    starting_id: entry.growup.cur_starting_id,
                    train_datas: entry.growup.assist_chars,
                })
            }
        }
        catalog.rankFacts(c, [
            ...new Set(
                catalog.rewards
                    .filter((row) => String(row.finishCondition).split('|')[0] === '80008')
                    .map((row) => row.groupId),
            ),
        ])
        const snapshot = catalog.snapshot(c.state, c.now, c)
        c.pushBefore('CSProtoSyncCommonTimeConf', catalog.commonTimes(c.now, c.state))
        c.pushBefore('CSProtoActivitySync', snapshot)
        const nday = catalog.nday(c.state, c.now)
        if (nday) c.pushBefore('SCProtoNDayInfoSync', nday)
        return { confs: snapshot.confs }
    })
    on('ActivityDailySign', (c, r) => {
        const { row, entry } = catalog.require(c.state, c.now, r.u32, [3])
        if (entry.sign.reward_count >= entry.sign.count) {
            publish(c)
            return { rewards: [] }
        }
        const rewards = []
        // Missed claims may be collected together, but only actual login days count.
        for (let day = entry.sign.reward_count + 1; day <= entry.sign.count; day++) {
            const reward = activityTables
                .get('game_events_day_attendance')
                .find((x) => x.eventId === row.systemId && x.date === day)
            ensure(reward, 'Missing attendance reward configuration', ErrorCode.ActivityRewardConfNone)
            rewards.push(...parseRewards(reward.reward))
        }
        const granted = grant(c, rewards)
        entry.sign.reward_count = entry.sign.count
        publish(c)
        return { rewards: granted, src: rewardSource(tables, 'activityDailySign') }
    })
    on('ActivitySign', (c, r) => {
        const { entry } = catalog.require(c.state, c.now, r.u32, [1])
        entry.sign.hidden = true
        publish(c)
        return {}
    })
    on('ActivityReward', (c, r) => {
        const { entry } = catalog.require(c.state, c.now, r.activity_id)
        ensure(r.reward_id_list?.length > 0 && r.reward_id_list.length <= 100, 'Missing activity reward selection')
        const rows = [...new Set(r.reward_id_list)].map((id) => {
            const row = catalog.rewards.find((x) => x.id === id && x.groupId === r.activity_id)
            ensure(row, 'Reward does not belong to activity')
            return row
        })
        const rankFacts = catalog.rankFacts(
            c,
            rows.some((row) => !entry.claims.includes(row.id) && String(row.finishCondition).split('|')[0] === '80008')
                ? [r.activity_id]
                : [],
        )
        for (const row of rows) {
            if (!entry.claims.includes(row.id)) {
                const value = catalog.condition(row.finishCondition, c.state, r.activity_id, rankFacts, c.now)
                ensure(
                    value !== null && value >= row.para,
                    'Activity reward conditions not complete',
                    String(row.finishCondition).split('|')[0] === '80008'
                        ? ErrorCode.ActivityRewardStateError
                        : ErrorCode.InvalidArgument,
                )
            }
        }
        const rewards = []
        for (const row of rows) {
            if (entry.claims.includes(row.id)) continue
            // dropId is the server reward pool; rewardShow is only a display preview.
            if (row.dropId) {
                for (const id of String(row.dropId).split('|')) {
                    const rolled = rollActivityRewardDrop(
                        tables,
                        c.state,
                        r.activity_id,
                        Number(id),
                        drops,
                        c.randomInt,
                    )
                    rewards.push(...grant(c, rolled.ordinary), ...rolled.activity)
                }
            } else rewards.push(...grant(c, parseRewards(row.reward)))
            if (String(row.finishCondition).split('|')[0] === '80008') {
                const value = rankFacts.get(r.activity_id)
                ensure(value, 'Cultivation rank claim has no current participation', ErrorCode.ActivityDataNone)
                ensure(
                    entry.cultRankClaims === undefined ||
                        (entry.cultRankClaims &&
                            typeof entry.cultRankClaims === 'object' &&
                            !Array.isArray(entry.cultRankClaims)),
                    'Invalid cultivation rank claim receipts',
                    ErrorCode.GameConfig,
                )
                entry.cultRankClaims = {
                    ...entry.cultRankClaims,
                    [row.id]: {
                        version: 1,
                        period_key: value.period_key,
                        score: value.score,
                        qualification: value.qualification,
                        ...(value.ranked ? { rank: value.rank, count: value.count, permyriad: value.permyriad } : {}),
                        time: c.now,
                    },
                }
            }
            entry.claims.push(row.id)
        }
        publish(c)
        return { rewards, src: rewardSource(tables, 'activityReward') }
    })
    on('ActivitySubmitItem', (c, r) => {
        const { row, entry } = catalog.require(c.state, c.now, r.activity_id, [30])
        const submission = activityTables.find('game_events_subitem', r.submit_id)
        ensure(submission?.groupId === row.systemId, 'Submission does not belong to activity')
        if (entry.submissions?.includes(submission.id)) return { rewards: [] }
        ensure(catalog.day(c.now) - catalog.day(entry.opened) + 1 >= submission.unlockTime, 'Submission day is locked')
        const costs = parseRewards(submission.subItem),
            items = new Map()
        for (const cost of costs) {
            if (cost.itemtype === 3) items.set(cost.itemid, (items.get(cost.itemid) ?? 0) + cost.itemnum)
            else {
                ensure(cost.itemtype === 10, 'Unsupported activity submission resource', ErrorCode.GameConfig)
                spendCurrency(c.state, cost.itemid, cost.itemnum)
            }
        }
        if (items.size) spend(c.state, items, 0, c.now)
        const rewards = grant(c, parseRewards(submission.reward))
        ;(entry.submissions ??= []).push(submission.id)
        publish(c)
        return { rewards, src: rewardSource(tables, 'activityReward') }
    })
    on('GetNDayReward', (c, r) => {
        const snapshot = catalog.nday(c.state, c.now)
        ensure(snapshot, 'Seven-day activity is locked')
        const row = catalog.rows.find((x) => x.type === 70),
            entry = catalog.entry(c.state, row.id)
        const rewards = []
        if (r.reward_type === 0) {
            // Current client ReqNDayReward encodes the target's GROUP DAY, not its ID.
            const group = activityTables
                .get('seven_day_target_group')
                .find((x) => x.event_id === row.id && x.day === r.reward_param)
            ensure(group && group.day <= snapshot.unlock_day, 'Seven-day group is locked')
            for (const target of activityTables.get('seven_day_target').filter((x) => x.group === group.group)) {
                if (snapshot.target_infos.find((x) => x.id === target.id)?.state !== 1) continue
                rewards.push(...grant(c, parseRewards(target.reward)))
                entry.nday_claims.push(target.id)
            }
        } else {
            ensure(r.reward_type === 1, 'Unknown seven-day reward type')
            const reward = activityTables.find('seven_day_target_reward', r.reward_param)
            ensure(reward, 'Unknown seven-day total reward')
            if (!entry.nday_totals.includes(reward.id)) {
                ensure(snapshot.total_count >= reward.count, 'Seven-day total requirement not reached')
                rewards.push(...grant(c, parseRewards(reward.reward)))
                entry.nday_totals.push(reward.id)
            }
        }
        publish(c)
        return { rewards, src: rewardSource(tables, 'activityReward') }
    })
    return catalog
}
