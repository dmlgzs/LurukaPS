import { claimAllBattlePassLevels } from '../battle-pass-level-batch.js'
import { claimBattlePassLevel } from '../battle-pass.js'
export function registerBattlePass(on) {
    on('BattlePassGetLevelReward', claimBattlePassLevel)
    on('BattlePassGetAllLevelReward', claimAllBattlePassLevels)
}
