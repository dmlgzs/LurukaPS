import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { repeatDungeon, repeatModeRecord } from './repeat-event.js'
import { getEntrustCatalog } from './entrust.js'
import { WorldObjectCatalog } from './world-objects.js'
import { grantRewards, parseRewards } from './rewards.js'
import { spend, spendCurrency } from './inventory.js'
import { rewardSource } from './reward-source.js'
import policy from '../configs/repeat-event-policy.json' with { type: 'json' }
import { repeatFavorRewardContext } from './hero-favor-rewards.js'

function active(c) {
    const run = c.state.entrust?.run
    ensure(
        run?.kind === 'repeat' && run.map_id === c.state.world.map_id && run.battle_complete,
        'Repeat battle has not completed',
        ErrorCode.RepeatEventLevelRewardNoUsabled,
    )
    const route = repeatDungeon(c.tables, run.dungeon_id),
        info = run.repeat_event
    const key = info.activity + ':' + info.level
    const record = c.state.repeatEvent?.levels?.[key]
    const mode = repeatModeRecord(c.state, info.activity, info.level, info.mode)
    ensure(
        route?.level.id === info.level && record && mode?.win_count > 0,
        'Missing repeat victory receipt',
        ErrorCode.RepeatEventLevelRewardNoUsabled,
    )
    return { run, route, info, key, record, mode }
}
function update(c, key, record, mode) {
    const ledger = (c.state.repeatEvent = { ...c.state.repeatEvent, levels: { ...c.state.repeatEvent.levels } })
    ledger.levels[key] = {
        ...record,
        mode_save_data: record.mode_save_data.map((row) => (row.mode === mode.mode ? mode : row)),
    }
    c.pushBefore('CSProtoRepeatEventLevelModify', { level_data: ledger.levels[key] })
}
function merged(rows) {
    const result = new Map()
    for (const reward of rows) {
        const key = reward.itemtype + ':' + reward.itemid,
            old = result.get(key)
        const itemnum = (old?.itemnum ?? 0) + reward.itemnum
        ensure(
            Number.isSafeInteger(itemnum) && itemnum > 0 && itemnum <= 0xffffffff,
            'Repeat reward quantity overflow',
            ErrorCode.GameConfig,
        )
        result.set(key, { ...reward, itemnum })
    }
    return [...result.values()]
}
// Deliberately called only from full inventory transactions (end, quit, claim,
// reentry and login). The high-frequency combat draft borrows inventory maps.
export function claimRepeatFirstPass(c) {
    if (
        c.state.entrust?.run?.kind !== 'repeat' ||
        !c.state.entrust.run.battle_complete ||
        c.state.entrust.run.map_id !== c.state.world.map_id
    )
        return []
    const { run, route, info, key, record, mode } = active(c)
    if (record.public_data?.frist_pass_reward_fetched) return []
    const drops = new WorldObjectCatalog(c.tables)
    const rolled = drops.drops(route.level.firstDrop, c.randomInt)
    const personalFavor = rolled.some((row) => row.itemtype === 10 && row.itemid === 4)
        ? repeatFavorRewardContext(c.tables, c.state, 'first-pass')
        : undefined
    const rewards = grantRewards(c.tables, c.state, rolled, 0, { personalFavor })
    record.public_data = { ...record.public_data, frist_pass_reward_fetched: true }
    update(c, key, record, mode)
    c.pushBefore('CSProtoRepeatEventFirstPassReward', {
        event_id: info.activity,
        level_id: info.level,
        rewards: { rewards, src: rewardSource(c.tables, 'repeatEventFirstClear') },
    })
    run.repeat_first_rewards = rewards
    return rewards
}
export function claimRepeatChest(c, times = 1) {
    const { run, route, info, key } = active(c)
    const catalog = getEntrustCatalog(c.tables),
        chest = catalog.chest(run.entrust_id)
    const options = new Set([
        1,
        ...String(c.tables.get('game').find((row) => row.title === 'DUNGEON_ENTRUST_STAMINA_REWARD')?.value ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number),
    ])
    ensure(
        Number.isSafeInteger(times) && options.has(times) && (times === 1 || chest.multimes === 1),
        'Invalid repeat chest multiplier',
        ErrorCode.StaminaBoxTimesInvalid,
    )
    if (run.chest_claimed) return { rewards: [], extra: [] }
    // This preflight precedes first-pass grants, random rolls and all costs.
    // Never reconstruct an old entry set from the current claim-time team.
    const baseFavor = repeatFavorRewardContext(c.tables, c.state, 'chest-base'),
        extraFavor = repeatFavorRewardContext(c.tables, c.state, 'chest-extra')
    ensure(
        c.now < (run.chest_ready_time ?? run.end_time) + chest.time,
        'Repeat chest expired',
        ErrorCode.StaminaBoxExpired,
    )
    claimRepeatFirstPass(c)
    const record = structuredClone(c.state.repeatEvent.levels[key]),
        mode = record.mode_save_data.find((row) => row.mode === info.mode)
    const free =
        (info.mode === 1 ? route.level.isFreeChestNormal : route.level.isFreeChestHard) === 1 && !mode.free_stamina_used
            ? 1
            : 0
    // A free box grants one share. If a custom client combines shares, only the
    // remaining shares are charged; the native UI initially selects one share.
    const paid = times - free
    ensure(
        !free || times === 1 || policy.freeSharePolicy === 'one-free-rest-paid',
        'Combined free share policy is not implemented',
        ErrorCode.FunctionClosed,
    )
    for (const cost of parseRewards(chest.need)) {
        const amount = cost.itemnum * paid
        ensure(Number.isSafeInteger(amount) && amount <= 0xffffffff, 'Repeat chest cost overflow', ErrorCode.GameConfig)
        if (!amount) continue
        if (cost.itemtype === 10) {
            if (cost.itemid === 3) {
                const have = c.state.player.attr_infos.attrs.find((row) => row.attr_id === 3)?.attr_val ?? '0'
                ensure(
                    /^\d+$/.test(String(have)) && BigInt(have) >= BigInt(amount),
                    'Insufficient stamina',
                    ErrorCode.StaminaNotEnough,
                )
            }
            spendCurrency(c.state, cost.itemid, amount)
        } else {
            ensure(cost.itemtype === 3, 'Repeat chest cost category unsupported', ErrorCode.FunctionClosed)
            spend(c.state, new Map([[cost.itemid, amount]]), 0, c.now)
        }
    }
    const sameDay =
        mode.bonus_reward_fetch_time !== undefined &&
        c.activityCatalog.day(mode.bonus_reward_fetch_time) === c.activityCatalog.day(c.now)
    const oldExtra = sameDay ? (mode.bonus_reward_daily_count ?? 0) : 0
    const maximum = info.mode === 1 ? route.level.normalExtraDropNum : route.level.hardExtraDropNum
    ensure(
        Number.isSafeInteger(maximum) && maximum >= 0 && Number.isSafeInteger(oldExtra) && oldExtra >= 0,
        'Invalid repeat bonus limit',
        ErrorCode.GameConfig,
    )
    const extras = Math.min(times, Math.max(0, maximum - oldExtra)),
        drop = info.mode === 1 ? route.level.normalExtraDrop : route.level.hardExtraDrop
    const rolls = new WorldObjectCatalog(c.tables),
        budget = { count: 0 },
        base = [],
        extra = []
    for (let i = 0; i < times; i++) base.push(...rolls.drops(chest.drop, c.randomInt, budget))
    for (let i = 0; i < extras; i++) extra.push(...rolls.drops(drop, c.randomInt, budget))
    // The current repeat base pools include currency4 (hero favor), not player
    // XP. Follow the existing commission per-share userExp rule explicitly;
    // official timing/multipliers remain a documented compatibility policy.
    ensure(
        Number.isSafeInteger(route.dungeon.userExp) && route.dungeon.userExp >= 0,
        'Invalid repeat player experience',
        ErrorCode.GameConfig,
    )
    ensure(
        policy.playerExperiencePolicy === 'existing-per-chest-share',
        'Repeat player experience settlement policy unavailable',
        ErrorCode.FunctionClosed,
    )
    if (route.dungeon.userExp) base.push({ itemtype: 10, itemid: 10, itemnum: route.dungeon.userExp * times })
    const rewards = grantRewards(c.tables, c.state, merged(base), 0, { personalFavor: baseFavor }),
        awardedExtra = grantRewards(c.tables, c.state, merged(extra), 0, { personalFavor: extraFavor })
    mode.free_stamina_used = mode.free_stamina_used || free === 1
    mode.bonus_reward_daily_count = oldExtra + extras
    mode.bonus_reward_fetch_time = c.now
    record.public_data = {
        ...record.public_data,
        daily_count: (sameDay ? (record.public_data?.daily_count ?? 0) : 0) + times,
    }
    update(c, key, record, mode)
    run.chest_claimed = true
    run.claim_times = times
    run.rewards = [...rewards, ...awardedExtra]
    run.stage_index = catalog.stages(run.entrust_id).at(-1).index + 1
    return { rewards, extra: awardedExtra }
}
