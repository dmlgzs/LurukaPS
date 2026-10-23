import { abyssDataSnapshot } from '../abyss-data.js'
import { claimAbyssPassRewards, claimAbyssStarRewards } from '../abyss-rewards.js'
export function registerAbyssData(on, tables) {
    on('AbyssData', (c) => abyssDataSnapshot(tables, c.state, c.now))
    on('AbyssGetPassReward', claimAbyssPassRewards)
    on('AbyssGetStarReward', claimAbyssStarRewards)
}
