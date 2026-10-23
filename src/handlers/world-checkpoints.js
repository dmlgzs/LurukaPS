import { openCheckpoint } from '../world-checkpoints.js'

export function registerWorldCheckpoints(on, tables) {
    on('WorldCheckpointOpen', (c, r) => openCheckpoint(tables, c.state, r))
}
