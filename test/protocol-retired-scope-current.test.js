import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('deferred legacy Kibo requests are not restored as empty successes or mapped onto current handlers', () => {
    const cfg = configuration(),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, new Tables(cfg.tables)),
        session = {}
    try {
        const enter = protocol.byName.get('CSProtoEnterGame')
        game.dispatch(session, {
            id: enter.id,
            seq: 1,
            payload: protocol.encode(enter.req, { open_id: 'current-retired-protocol-scope' }),
        })
        const before = structuredClone(store.load(session.id)),
            changes = store.db.prepare('SELECT total_changes() AS n').get().n
        for (const id of [10741, 10743, 10742, 10750, 10746, 10745]) {
            assert.equal(protocol.byId.has(id), false)
            assert.equal(game.handlers.has(id), false)
            assert.throws(
                () => game.dispatch(session, { id, seq: id, payload: Buffer.alloc(0) }),
                (error) => error.code === ErrorCode.InvalidProtoID,
            )
        }
        assert.deepEqual(store.load(session.id), before)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes)
    } finally {
        store.close()
    }
})
