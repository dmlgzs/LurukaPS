import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { registerPetMutations } from '../src/handlers/pet-mutation.js'

test('adding private mutation code does not register unverified public6539/6544 in the default Game', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    try {
        const game = new Game(protocol, store, tables)
        assert.equal(game.handlers.has(6539), false)
        assert.equal(game.handlers.has(6544), false)
        let registrations = 0
        assert.equal(
            registerPetMutations(() => registrations++, tables),
            false,
        )
        assert.equal(registrations, 0)
    } finally {
        store.close()
    }
})
