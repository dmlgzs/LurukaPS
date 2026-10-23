import { abyssTables, abyssModeLevels } from './abyss-catalog.js'
import { abyssModeRecord } from './abyss-run.js'
import { abyssDataSnapshot } from './abyss-data.js'
import { grantRewards, parseRewards } from './rewards.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function abyssClaimContext(c, request) {
    const tables = abyssTables(c.tables),
        context = abyssModeLevels(tables, request.mode, c.now),
        snapshot = abyssDataSnapshot(tables, c.state, c.now),
        field = ['newer', 'persistent', 'rotation'][request.mode - 1],
        mode = abyssModeRecord(c.state, request.mode, context.rotation)
    return { tables, mode, context, snapshot, field }
}
export function claimAbyssPassRewards(c, request) {
    const { tables, mode, snapshot, field } = abyssClaimContext(c, request),
        selected = snapshot[field + '_mode_info'].filter((x) => x.passed && !x.pass_level_reward_flag)
    ensure(selected.length > 0, 'No unclaimed abyss pass rewards', ErrorCode.AbyssPassedRewardAlready)
    // Parse all rows before mutating any claim receipt. Real delivery uses the
    // same item/hero/pet creation path as other rewards, never a UI-only list.
    const plan = selected.map((row) => ({
        row,
        rewards: parseRewards(tables.find('abbys_level', row.cur_level).levelReward),
    }))
    for (const { row, rewards } of plan) {
        grantRewards(c.tables, c.state, rewards, 0, { randomInt: c.randomInt })
        mode.levels[row.cur_level] = {
            ...mode.levels[row.cur_level],
            pass_level_reward_flag: true,
        }
    }
    // 11452 has no rewards/src fields. Its real client callback parses the
    // configured reward for EACH returned level; returning old claims would
    // display rewards again even when nothing was added to the bag.
    return {
        mode: request.mode,
        level_info: selected.map((row) => ({ ...row, pass_level_reward_flag: true })),
    }
}
export function claimAbyssStarRewards(c, request) {
    const { tables, mode, context, snapshot, field } = abyssClaimContext(c, request),
        group = request.mode === 3 ? context.rotation.reward : context.row.reward,
        rows = tables
            .get('abbys_reward')
            .filter((row) => row.groupId === group)
            .sort((a, b) => a.num - b.num),
        levels = snapshot[field + '_mode_info'],
        stars = levels.filter((x) => x.passed).reduce((n, x) => n + x.star_num, 0),
        maxStars = context.levels.reduce((n, id) => n + tables.find('abbys_level', id).star, 0)
    ensure(
        rows.length > 0 &&
            rows.every(
                (row, i) =>
                    Number.isSafeInteger(row.num) &&
                    row.num > 0 &&
                    row.num <= maxStars &&
                    (!i || row.num > rows[i - 1].num),
            ),
        'Abyss star reward group is invalid',
        ErrorCode.AbyssStarRewardInvalidGroup,
    )
    const claimed = new Set(mode.starClaims ?? []),
        selected = rows.filter((row) => row.num <= stars && !claimed.has(row.num)),
        plan = selected.map((row) => ({ row, rewards: parseRewards(row.reward) }))
    ensure(selected.length > 0, 'No unclaimed abyss star rewards', ErrorCode.AbyssStarRewardAlready)
    for (const { row, rewards } of plan) {
        grantRewards(c.tables, c.state, rewards, 0, { randomInt: c.randomInt })
        claimed.add(row.num)
    }
    mode.starClaims = [...claimed].sort((a, b) => a - b)
    return {
        mode: request.mode,
        reward_info: {
            reward_list: rows.filter((r) => claimed.has(r.num)).map((r) => ({ stage_num: r.num, reward_flag: true })),
        },
    }
}
