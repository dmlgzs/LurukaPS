import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('6022 saves lock and unlock independently of equipment ownership and publishes the changed instance before ACK', () => {
    const f = ornamentFixture('ornament-lock')
    try {
        const hero = f.state().player.heros_info.heros[0],
            item = f.state().ornaments[0]
        f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: item.guid })
        const heroBefore = structuredClone(f.state().player.heros_info.heros)
        for (const lock of [true, true, false]) {
            const packets = f.call('SetLockOrnament', { guid: item.guid, lock })
            assert.equal(packets.at(-1).id, 6022)
            const update = packets.slice(0, -1).find((packet) => packet.id === 6029)
            assert.ok(update)
            const data = f.protocol.decode(f.protocol.byId.get(6029).rsp, update.payload)
            assert.equal(data.ornaments.find((row) => row.guid === item.guid).lock, lock)
            assert.equal(f.state().ornaments.find((row) => row.guid === item.guid).lock, lock)
            assert.deepEqual(f.state().player.heros_info.heros, heroBefore)
        }
        f.call('SetLockOrnament', { guid: item.guid, lock: true })
        f.reload()
        assert.equal(f.state().ornaments.find((row) => row.guid === item.guid).lock, true)
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('SetLockOrnament', { guid: 0xffffffff, lock: true }),
            (error) => error.code === ErrorCode.OrnamentNotExist,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
