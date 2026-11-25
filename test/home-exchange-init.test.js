import test from 'node:test'
import assert from 'node:assert/strict'
import { petCosmeticsFixture } from './pet-cosmetics-fixture.js'

test('a request reaching the current market level initializes and synchronizes before its ACK without retired6221', () => {
    const f = petCosmeticsFixture('obt-market-online-level')
    try {
        assert.equal(f.state().home.level, 1)
        assert.equal(f.state().homeExchange, undefined)
        const entry = f.protocol.byName.get('CSProtoWorldTimeSync')
        const original = f.game.handlers.get(entry.id)
        // Simulate an accepted domain reward increasing cultivation level. The
        // real dispatcher/observers and current market initialization still run.
        f.game.handlers.set(entry.id, (c, r) => {
            const response = original(c, r)
            c.state.home.level = 5
            return response
        })
        const packets = f.call('WorldTimeSync', { world_time: 1200 })
        assert(f.state().homeExchange)
        assert(f.state().homeExchange.market)
        const ack = packets.findIndex((p) => p.id === entry.id)
        for (const id of [6219, 6229]) {
            const index = packets.findIndex((p) => p.id === id)
            assert(index >= 0 && index < ack, `market synchronization ${id} precedes ACK`)
            f.decode(packets, id)
        }
        assert.equal(f.protocol.byId.has(6221), false)
    } finally {
        f.store.close()
    }
})
