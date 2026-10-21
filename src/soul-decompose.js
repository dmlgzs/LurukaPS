import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'

export function soulDecomposePlan(tables, state, guids) {
    const limit = Number(
        tables.get('game').find((row) => row.title === 'SOULESSENCE_DECOMPOSE_SELECT_COUNT_LIMIT')?.value,
    )
    ensure(
        Number.isSafeInteger(limit) && limit > 0,
        'Soul decompose limit configuration unavailable',
        ErrorCode.GameConfig,
    )
    ensure(
        Array.isArray(guids) && guids.length > 0 && guids.length <= limit && new Set(guids).size === guids.length,
        'Invalid or duplicate soul decompose selection',
    )
    const selected = new Set(),
        rewards = new Map()
    for (const guid of guids) {
        const item = state.player.soulessence_infos.soulessences.find((item) => item.guid === guid)
        ensure(item, 'Soul essence is not owned', ErrorCode.SoulEssenceNotExist)
        const config = tables.find('soulessence', item.id)
        ensure(config, 'Soul essence configuration unavailable', ErrorCode.SoulEssenceConfNotExist)
        ensure(
            Number.isInteger(config.rarity) &&
                config.rarity > 0 &&
                Number.isInteger(item.lv) &&
                item.lv >= 1 &&
                Number.isInteger(item.advance) &&
                item.advance >= 1,
            'Invalid soul decomposition item state',
            ErrorCode.GameConfig,
        )
        ensure(!item.lock, 'Soul essence is locked', ErrorCode.LockSoulEssence)
        ensure(
            (!item.wear_hero || item.wear_hero === '0') &&
                !state.player.heros_info.heros.some((hero) => hero.wguid === guid),
            'Soul essence is equipped',
            ErrorCode.SoulEssenceOnWear,
        )
        // Current PageSoulEssenceDecompose._InitSoulEssenceData explicitly
        // excludes strengthened/refined and rarity-4 items from this operation.
        ensure(
            !item.zombie && item.lv === 1 && item.advance === 1 && config.rarity !== 4,
            'Soul essence is not eligible for decomposition',
        )
        const configured = parseRewards(config.decomposed)
        ensure(configured.length > 0, 'Soul decomposition reward configuration unavailable', ErrorCode.GameConfig)
        for (const reward of configured) {
            const key = reward.itemtype + ':' + reward.itemid
            const previous = rewards.get(key),
                total = (previous?.itemnum ?? 0) + reward.itemnum
            ensure(
                Number.isSafeInteger(total) && total <= 0xffffffff,
                'Soul decomposition reward overflow',
                ErrorCode.GameConfig,
            )
            rewards.set(key, { ...reward, itemnum: total })
        }
        selected.add(guid)
    }
    // Preview adds the table list once per instance; no grade/level multiplier
    // or returned strengthening XP is part of that current client calculation.
    return { selected, rewards: [...rewards.values()] }
}
