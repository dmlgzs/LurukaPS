import test from 'node:test'
import assert from 'node:assert/strict'
import { Protocol } from '../src/protocol.js'
import { configuration } from '../src/config.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'

test('exchange synchronization assertions reject missing, wrong or late packets and missing acknowledgements', () => {
    const protocol = new Protocol(configuration().base)
    for (const target of [6222, 6224, 6227, 6228]) {
        for (const name of ['CSProtoSyncPlayerData', 'CSProtoReputationInfo']) {
            const sync = protocol.byName.get(name).id
            assert.throws(() => assertSyncBefore(protocol, [{ id: target }], name, target), /Missing/)
            assert.throws(() => assertSyncBefore(protocol, [{ id: 6023 }, { id: target }], name, target), /Missing/)
            assert.throws(() => assertSyncBefore(protocol, [{ id: target }, { id: sync }], name, target), /before/)
            assert.throws(() => assertSyncBefore(protocol, [{ id: sync }], name, target), /Missing target/)
            assert.equal(assertSyncBefore(protocol, [{ id: sync }, { id: target }], name, target)[0].id, sync)
        }
    }
})
