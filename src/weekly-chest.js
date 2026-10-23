import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { getEntrustCatalog, entrustChestGivenUp } from './entrust.js'
import { prepareWeeklyQuota, weeklyQuotaView } from './weekly-dungeons.js'
import { WorldObjectCatalog } from './world-objects.js'
import { parseRewards, grantRewards } from './rewards.js'
import { spendCurrency } from './inventory.js'
import { dungeonFavorRewardContext } from './hero-favor-rewards.js'

export function claimWeeklyChest(c, request) {
    ensure(
        Number.isSafeInteger(request.times) && request.times === 1,
        'Weekly chest supports one reward share only',
        ErrorCode.StaminaBoxTimesInvalid,
    )
    const run = c.state.entrust?.run
    ensure(run?.kind === 'weekly', 'Weekly stamina chest does not exist', ErrorCode.StaminaBoxNotExist)
    ensure(run.map_id === c.state.world.map_id, 'Not in weekly chest map', ErrorCode.NotInMap)
    const catalog = getEntrustCatalog(c.tables),
        config = catalog.get(run.entrust_id, 'weekly'),
        chest = catalog.chest(run.entrust_id, 'weekly')
    ensure(request.box_id === chest.id, 'Weekly stamina chest does not exist', ErrorCode.StaminaBoxNotExist)
    ensure(
        run.battle_complete === true && !entrustChestGivenUp(c.tables, run),
        'No completed weekly stamina chest',
        ErrorCode.StaminaBoxNotExist,
    )
    ensure(
        Number.isSafeInteger(run.instance_id) &&
            run.instance_id > 0 &&
            Number.isSafeInteger(c.now) &&
            c.now >= 0 &&
            Number.isSafeInteger(run.chest_ready_time ?? run.end_time) &&
            Number.isSafeInteger(chest.time) &&
            chest.time > 0 &&
            chest.type === 6,
        'Invalid weekly chest instance or configuration',
        ErrorCode.GameConfig,
    )
    // Existing local chest claims are replay-safe. A different request nonce
    // cannot charge or create another share from this completed instance.
    if (run.chest_claimed) return []
    ensure(
        c.now < (run.chest_ready_time ?? run.end_time) + chest.time,
        'Weekly stamina chest expired',
        ErrorCode.StaminaBoxExpired,
    )
    prepareWeeklyQuota(c.tables, c.state, c.now)
    const quota = weeklyQuotaView(c.tables, c.state, c.now),
        costs = parseRewards(chest.need)
    ensure(
        costs.length === 2 &&
            costs.every((r) => r.itemtype === 10 && [3, 104].includes(r.itemid)) &&
            new Set(costs.map((r) => r.itemid)).size === 2,
        'Weekly chest fee configuration invalid',
        ErrorCode.GameConfig,
    )
    const quotaCost = costs.find((r) => r.itemid === 104),
        staminaCost = costs.find((r) => r.itemid === 3)
    ensure(quota.amount >= BigInt(quotaCost.itemnum), 'Weekly reward quota exhausted', ErrorCode.StaminaBoxWeeklyLimit)
    const stamina = c.state.player.attr_infos.attrs.filter((r) => r.attr_id === 3)
    ensure(
        stamina.length === 1 && /^\d+$/.test(String(stamina[0].attr_val)),
        'Invalid weekly stamina balance',
        ErrorCode.GameConfig,
    )
    ensure(
        BigInt(stamina[0].attr_val) >= BigInt(staminaCost.itemnum),
        'Insufficient weekly chest stamina',
        ErrorCode.StaminaNotEnough,
    )
    const drop = new WorldObjectCatalog(c.tables),
        budget = { count: 0 },
        rolled = drop.drops(chest.drop, c.randomInt, budget)
    const challenges = String(config.weekly.challengeReward || '')
        .split('|')
        .map(Number)
    ensure(
        challenges.length === 3 && challenges.every((id) => Number.isSafeInteger(id) && id > 0),
        'Weekly challenge bonus configuration unavailable',
        ErrorCode.GameConfig,
    )
    ensure(
        Number.isInteger(run.star_mask) && run.star_mask >= 0 && run.star_mask <= 7,
        'Invalid weekly current star mask',
        ErrorCode.GameConfig,
    )
    for (const [index, id] of challenges.entries())
        if ((run.star_mask >>> index) & 1) rolled.push(...drop.drops(id, c.randomInt, budget))
    const combined = new Map()
    for (const reward of rolled) {
        const key = `${reward.itemtype}:${reward.itemid}`,
            old = combined.get(key)
        if (old) {
            old.itemnum += reward.itemnum
            ensure(
                Number.isSafeInteger(old.itemnum) && old.itemnum <= 0xffffffff,
                'Weekly merged reward overflow',
                ErrorCode.GameConfig,
            )
        } else combined.set(key, { ...reward })
    }
    const rewards = [...combined.values()]
    // Do not fabricate favor or userExp. Only an actual currency4 drop uses
    // the user's already selected eligible-entry-hero-each LOCAL policy.
    const personalFavor = rewards.some((r) => r.itemtype === 10 && r.itemid === 4)
        ? dungeonFavorRewardContext(c.tables, c.state, 'weekly-chest')
        : undefined
    for (const cost of costs) spendCurrency(c.state, cost.itemid, cost.itemnum)
    run.rewards = grantRewards(c.tables, c.state, rewards, 0, { personalFavor })
    run.chest_claimed = true
    run.claim_times = 1
    run.stage_index = catalog.stages(run.entrust_id, 'weekly').at(-1).index + 1
    return run.rewards
}
