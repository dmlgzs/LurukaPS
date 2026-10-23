import { closeCheckpoint, openCheckpoint } from '../world-checkpoints.js'

export function registerWorldCheckpoints(on, tables) {
    on('WorldCheckpointOpen', (c, r) => {
        return openCheckpoint(tables, c.state, r)
    })
    on('WorldCheckpointClose', (c, r) => {
        // The current 9145 callback unconditionally removes its single ID.
        // Game emits the final scene's complete list after ACK and task refresh.
        return closeCheckpoint(tables, c.state, r)
    })
}
