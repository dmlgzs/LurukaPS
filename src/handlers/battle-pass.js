import { claimAllBattlePassTasks } from '../battle-pass-task-batch.js'
import { claimBattlePassTask } from '../battle-pass-tasks.js'
import { claimBattlePassSoul } from '../battle-pass-soul.js'
import { buyBattlePassLevels } from '../battle-pass-buy-level.js'
import { claimAllBattlePassLevels } from '../battle-pass-level-batch.js'
import { claimBattlePassLevel } from '../battle-pass.js'
export function registerBattlePass(on) {
    on('BattlePassGetLevelReward', claimBattlePassLevel)
    on('BattlePassGetAllTaskReward', claimAllBattlePassTasks)
    on('BattlePassGetTaskReward', claimBattlePassTask)
    on('BattlePassSelectSoulEssence', claimBattlePassSoul)
    on('BattlePassBuyLevel', buyBattlePassLevels)
    on('BattlePassGetAllLevelReward', claimAllBattlePassLevels)
}
