import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { activeAbyssRotation } from './abyss-rotation.js'
const fields = ['newer', 'persistent', 'rotation']
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export function abyssDataSnapshot(tables, state, now, policy) {
    const data = state.abyss ?? {},
        result = {}
    const rotation = activeAbyssRotation(tables, now, policy)
    for (let mode = 1; mode <= 3; mode++) {
        const row = tables.find('abbys_mode', mode)
        ensure(row, 'Abyss mode configuration unavailable', ErrorCode.AbyssInvalidMode)
        const active = mode !== 3 || !!rotation
        const levelIds = active ? ids(mode === 3 ? rotation.level : row.level) : []
        ensure(
            new Set(levelIds).size === levelIds.length && levelIds.every((id) => Number.isSafeInteger(id) && id > 0),
            'Invalid abyss level list',
            ErrorCode.GameConfig,
        )
        const saved =
            mode === 3
                ? rotation && data.rotation?.id === rotation.id
                    ? data.rotation
                    : {}
                : (data.modes?.[mode] ?? {})
        result[fields[mode - 1] + '_mode_info'] = levelIds.map((id) => {
            const config = tables.find('abbys_level', id),
                old = saved.levels?.[id]
            ensure(config?.mode === mode, 'Abyss level configuration unavailable', ErrorCode.AbyssInvalidLevel)
            const star = old?.star_num ?? 0
            ensure(
                Number.isInteger(star) && star >= 0 && star <= config.star,
                'Invalid saved abyss star count',
                ErrorCode.GameConfig,
            )
            return {
                cur_level: id,
                challenge_list: structuredClone(old?.challenge_list ?? []),
                pass_level_reward_flag: old?.pass_level_reward_flag === true,
                star_num: star,
                passed: old?.passed === true,
                task_tags_list: structuredClone(old?.task_tags_list ?? []),
            }
        })
        const group = mode === 3 ? rotation?.reward : row.reward
        const rewards = active
            ? tables
                  .get('abbys_reward')
                  .filter((r) => r.groupId === group)
                  .sort((a, b) => a.num - b.num)
            : []
        ensure(
            !active || rewards.length > 0,
            'Abyss star reward configuration unavailable',
            ErrorCode.AbyssStarRewardInvalidGroup,
        )
        const claimed = new Set(saved.starClaims ?? [])
        ensure(
            claimed.size === (saved.starClaims?.length ?? 0) &&
                [...claimed].every((n) => rewards.some((r) => r.num === n)) &&
                rewards.slice(0, claimed.size).every((r) => claimed.has(r.num)),
            'Invalid saved abyss star reward receipts',
            ErrorCode.GameConfig,
        )
        result[fields[mode - 1] + '_star_reward_info'] = {
            // Native GetStarRewardData derives this-claim popup data from the
            // newly appended suffix of this cumulative list. Unclaimed tiers
            // come from abbys_reward and must not pre-fill that client cache.
            reward_list: rewards.filter((r) => claimed.has(r.num)).map((r) => ({ stage_num: r.num, reward_flag: true })),
        }
    }
    return {
        ...result,
        rotation_id: rotation?.id ?? 0,
        rotation_mode_end_time: rotation?.effectiveEnd ?? 0,
        max_rotation_3star_count: data.maxRotation3starCount ?? 0,
        inherit_notify_flag: data.inheritNotify === true,
        last_rotation_heros: structuredClone(data.lastRotationHeroes ?? []),
        rotation_remind_mail_sent_rotation_id: data.rotationRemindMailSentRotationId ?? 0,
    }
}
