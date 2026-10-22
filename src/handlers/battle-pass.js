import { claimBattlePassLevel } from '../battle-pass.js'
export function registerBattlePass(on) {
    on('BattlePassGetLevelReward', claimBattlePassLevel)
}
