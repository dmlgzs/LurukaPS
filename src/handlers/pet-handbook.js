import { preparePetHandbook, handbookRewardPlan, markHandbookDirty } from '../pet-handbook.js'
import { parseRewards, grantRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'
import { mergeCollectionRewards } from '../collection-claims.js'

export function registerPetHandbook(on) {
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
