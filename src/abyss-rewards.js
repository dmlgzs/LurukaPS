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
