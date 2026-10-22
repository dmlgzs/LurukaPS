import { switchWorldDifficulty } from '../world-difficulty.js'
export function registerWorldDifficulty(on) {
    on('WorldDifficultySwitch', switchWorldDifficulty)
}
