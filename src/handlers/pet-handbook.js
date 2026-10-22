import { preparePetHandbook, handbookRewardPlan, markHandbookDirty } from '../pet-handbook.js'
import { parseRewards, grantRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'
import { mergeCollectionRewards } from '../collection-claims.js'
import { handbookPalettes } from '../pet-handbook-appearance.js'
import { ensure } from './common.js'
import { ErrorCode } from '../error-codes.js'

export function registerPetHandbook(on) {
    on('PetHandbookColorfulSelect', (c, request) => {
        preparePetHandbook(c.tables, c.state)
        const row = c.state.petHandbook?.[request.pet_id]
        ensure(row, 'Pet handbook entry is not acquired', ErrorCode.PetHandbookNotFound)
        ensure(row.pet_id === request.pet_id, 'Saved handbook identity is inconsistent', ErrorCode.GameConfig)
        const palette = request.colorful_id ?? 0
        ensure(
            Number.isSafeInteger(palette) && palette >= 0 && palette <= 0xffffffff,
            'Invalid handbook star-color selection',
            ErrorCode.InvalidArgument,
        )
        const palettes = handbookPalettes(c.tables)
        ensure(
            Array.isArray(row.colorfuls ?? []) &&
                (row.colorfuls ?? []).every((id) => Number.isSafeInteger(id) && palettes.has(id)),
            'Invalid saved handbook star-color history',
            ErrorCode.GameConfig,
        )
        ensure(!palette || palettes.has(palette), 'Unknown handbook star-color palette', ErrorCode.HandbookConfNone)
        ensure(
            !palette || row.colorfuls?.includes(palette),
            'Handbook star-color palette is not acquired',
            ErrorCode.PetHandbookHaveNone,
        )
        if ((row.selected_colorful ?? 0) !== palette) {
            c.state.petHandbook = { ...c.state.petHandbook, [row.pet_id]: { ...row, selected_colorful: palette } }
            markHandbookDirty(c.state, row.pet_id)
        }
        // This is a catalog preview preference, not a dye operation on all
        // owned instances. The current Lua page still selects locally.
        return { pet_id: row.pet_id, colorful_id: palette }
    })
    on('PetHandbookRewardGet', (c) => {
        preparePetHandbook(c.tables, c.state)
        const plan = handbookRewardPlan(c.tables, c.state),
            rewards = []
        for (const entry of plan)
            for (const text of entry.rewards) rewards.push(...grantRewards(c.tables, c.state, parseRewards(text)))
        for (const entry of plan) {
            c.state.petHandbook = {
                ...c.state.petHandbook,
                [entry.row.pet_id]: { ...entry.row, rewarded_lv: entry.row.lv },
            }
            markHandbookDirty(c.state, entry.row.pet_id)
        }
        return {
            reward: { rewards: mergeCollectionRewards(rewards), src: rewardSource(c.tables, 'petHandbookLevelReward') },
        }
    })
}
