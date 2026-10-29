import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchBonusFixture } from './ranch-bonus-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('6163 validates merged typed warehouse wire bounds before any wallet credit', () => {
    const f = ranchBonusFixture('ranch-store-whole-schema')
    try {
        f.assign()
        f.edit((state) => {
            state.home.ranches[201].stores = [
                { itemtype: 10, itemid: 103, itemnum: 0xffffffff },
                { itemtype: 10, itemid: 103, itemnum: 1 },
            ]
        })
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('RanchGetStoreReward', { u32: 201 }), { code: ErrorCode.GameConfig })
        assert.deepEqual(f.store.load(f.session.id), before)
        f.edit((state) => {
            state.home.ranches[201].stores = [
                { itemtype: 10, itemid: 103, itemnum: 500 },
                { itemtype: 10, itemid: 103, itemnum: 5000 },
            ]
        })
        const packets = f.call('RanchGetStoreReward', { u32: 201 })
        const reply = f.protocol.decode('Rewards', packets.find((packet) => packet.id === 6163).payload)
        assert.deepEqual(
            reply.rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
            [{ itemtype: 10, itemid: 103, itemnum: 5500 }],
        )
    } finally {
        f.close()
    }
})
