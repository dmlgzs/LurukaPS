import { configTime } from './shops.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
const fields = ['newer', 'persistent', 'rotation']
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export function abyssDataSnapshot(tables, state, now) {
    const data = state.abyss ?? {},
        result = {}
    const periods = tables
        .get('abbys_time')
        .filter((row) => configTime(row.startTime) <= now && now < configTime(row.endTime))
    ensure(periods.length <= 1, 'Ambiguous abyss rotation configuration', ErrorCode.GameConfig)
    const rotation = periods[0]
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
        result[fields[mode - 1] + '_star_reward_info'] = {
            reward_list: rewards.map((r) => ({ stage_num: r.num, reward_flag: claimed.has(r.num) })),
        }
    }
    return {
        ...result,
        rotation_id: rotation?.id ?? 0,
        rotation_mode_end_time: rotation ? configTime(rotation.endTime) : 0,
        max_rotation_3star_count: data.maxRotation3starCount ?? 0,
        inherit_notify_flag: data.inheritNotify === true,
        last_rotation_heros: structuredClone(data.lastRotationHeroes ?? []),
        rotation_remind_mail_sent_rotation_id: data.rotationRemindMailSentRotationId ?? 0,
    }
}
