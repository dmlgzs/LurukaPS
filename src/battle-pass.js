import overrides from '../configs/battle-pass-overrides.json' with { type: 'json' }
import activityPolicy from '../configs/activity-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { configTime } from './shops.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
export function battlePassRow(name, original) {
    const row = { ...original }
    for (const [field, patch] of Object.entries(overrides[name]?.[row.id] ?? {}))
        if (row[field] === patch.from) row[field] = patch.to
    return row
}
const catalogues = new WeakMap()
export function battlePassModel(tables) {
    if (!catalogues.has(tables)) {
        const constants = new Map(tables.get('mall_game').map((r) => [r.title, r.value]))
        const initial = Number(constants.get('BATTLE_PASS_INITIAL_LEVEL'))
        ensure(
            Number.isSafeInteger(initial) && initial > 0,
            'Invalid battle pass initial level',
            ErrorCode.BattlePassConfInvalid,
        )
        const seasons = tables.get('battle_pass').map((original) => {
            const row = battlePassRow('battle_pass', original)
            const rewards = tables
                .get('battle_pass_reward')
                .filter((r) => r.teamId === row.rewardId)
                .sort((a, b) => a.level - b.level)
            ensure(
                rewards.length > 0 && rewards.every((r, i) => r.level === i + 1) && initial <= rewards.length,
                'Invalid battle pass reward levels',
                ErrorCode.BattlePassConfInvalid,
            )
            return {
                row,
                start: configTime(row.startTime),
                end: configTime(row.endTime),
                rewards,
                maxLevel: rewards.length,
            }
        })
        catalogues.set(tables, { seasons, initial, constants })
    }
    return catalogues.get(tables)
}
export function activeBattlePass(tables, now) {
    const rows = battlePassModel(tables)
        .seasons.map((season) => ({
            ...season,
            // Existing offline activity policy extends expired CBT schedules. This
            // is explicitly local and keeps the original start in the season key.
            effectiveEnd:
                season.end && season.end < now
                    ? configTime(activityPolicy.expiredEndTime)
                    : season.end || configTime(activityPolicy.missingTimeEndTime),
        }))
        .filter((season) => now >= season.start && now <= season.effectiveEnd)
    ensure(rows.length <= 1, 'Ambiguous active battle pass seasons', ErrorCode.BattlePassConfInvalid)
    return rows[0] ?? null
}
export function prepareBattlePass(tables, state, now) {
    const season = activeBattlePass(tables, now)
    if (!season) return null
    const root = (state.battlePass ??= { version: 1, seasons: {} })
    ensure(
        root.version === 1 && root.seasons && typeof root.seasons === 'object',
        'Invalid saved battle pass state',
        ErrorCode.GameConfig,
    )
    const key = season.row.id + ':' + season.start
    const ledger = (root.seasons[key] ??= {
        level: battlePassModel(tables).initial,
        exp: 0,
        curr_week_exp: 0,
        pay_state: 0,
        free: [],
        paid: [],
        tasks: {},
    })
    root.activeKey = key
    ensure(
        Number.isSafeInteger(ledger.level) &&
            ledger.level >= 1 &&
            ledger.level <= season.maxLevel &&
            [0, 1, 2].includes(ledger.pay_state) &&
            Array.isArray(ledger.free) &&
            Array.isArray(ledger.paid),
        'Invalid saved battle pass progression',
        ErrorCode.GameConfig,
    )
    return { season, ledger, key }
}
export function battlePassInfo(prepared) {
    if (!prepared) return { battlepass_id: 0 }
    const { season, ledger } = prepared
    return {
        battlepass_id: season.row.id,
        level: ledger.level,
        exp: ledger.exp,
        curr_week_exp: ledger.curr_week_exp,
        pay_state: ledger.pay_state,
        recved_free_rewards: ledger.free,
        recved_pay_rewards: ledger.paid,
        is_refund: !!ledger.is_refund,
        day_task: [],
        week_task: [],
        forever_task: [],
    }
}
export function battlePassSnapshot(tables, state, now) {
    const prepared = prepareBattlePass(tables, state, now)
    return {
        info: battlePassInfo(prepared),
        battlepass_end_time: prepared ? String(prepared.season.effectiveEnd) : '0',
    }
}
export function requireBattlePass(c) {
    const prepared = prepareBattlePass(c.tables, c.state, c.now)
    ensure(prepared, 'No active battle pass', ErrorCode.BattlePassNotFond)
    return prepared
}
export function publishBattlePassRewards(c, ledger) {
    c.pushBefore('SCProtoBattlePassLevelRewardSync', {
        recved_free_rewards: ledger.free,
        recved_pay_rewards: ledger.paid,
    })
}
export function claimBattlePassLevel(c, r) {
    const { season, ledger } = requireBattlePass(c)
    ensure(
        Number.isSafeInteger(r.level) && r.level > 0 && r.level <= season.maxLevel && r.level <= ledger.level,
        'Battle pass level is not reached',
        ErrorCode.BattlePassLevelExceeded,
    )
    const paid = !!r.is_paid,
        row = season.rewards[r.level - 1]
    if (paid) {
        ensure(!ledger.is_refund, 'Battle pass premium is refunded', ErrorCode.BattlePassRefund)
        ensure(ledger.pay_state > 0, 'Battle pass premium is not purchased', ErrorCode.BattlePassNotPaid)
        ensure(!row.soulessenceMark, 'Battle pass soul essence requires explicit selection', ErrorCode.FunctionClosed)
    }
    const received = paid ? ledger.paid : ledger.free
    if (received.includes(r.level)) {
        publishBattlePassRewards(c, ledger)
        return { rewards: [] }
    }
    const rewards = grantRewards(c.tables, c.state, parseRewards(paid ? row.advancedReward : row.commonReward))
    received.push(r.level)
    received.sort((a, b) => a - b)
    publishBattlePassRewards(c, ledger)
    return { rewards, src: rewardSource(c.tables, paid ? 'battlePassPaidLevel' : 'battlePassFreeLevel') }
}
