import { switchWorldDifficulty, acknowledgeWorldDifficulty } from '../world-difficulty.js'
export function registerWorldDifficulty(on) {
    on('WorldDifficultySwitch', switchWorldDifficulty)
    on('WorldDifficultyRedPointSet', acknowledgeWorldDifficulty)
}
