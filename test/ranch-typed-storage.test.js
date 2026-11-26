import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchBonusFixture, ranchBonusFile } from './ranch-bonus-fixture.js'
import { ranchStoredSlots } from '../src/ranch-claims.js'
import { ErrorCode } from '../src/error-codes.js'

const coins = (state) => BigInt(state.player.attr_infos.attrs.find((row) => row.attr_id === 103)?.attr_val ?? '0')
function storedCurrencyPrecondition(f, amounts = [500, 5000]) {
    f.assign()
    f.harvestWorker()
    f.elapse(
        Math.min(
            ...f
                .state()
                .home.ranches[201].product_pets.flatMap((slot) => slot.drop_times.map((clock) => clock.seconds)),
        ),
    )
    f.tick()
    // Consumer-only saved valid drops: this stage does not claim a bonus producer.
    return f.edit((state) => {
        const ranch = state.home.ranches[201]
        return amounts.map((amount, index) => {
            const guid = ranch.nextDropGuid++
            ranch.drops.push({
                guid,
                pet_guid: f.pets[0],
                drop_id: index ? 1056 : 1052,
                item: { itemtype: 10, itemid: 103, itemnum: amount },
            })
            return guid
        })
    })
}
test('typed6161 stores500/5000 as one currency row without wallet grant; actual6163 grants once and survives SQLite reopen', () => {
    const temp = ranchBonusFile(),
        f = ranchBonusFixture('typed-ranch-sqlite', { file: temp.file })
    try {
        const ids = storedCurrencyPrecondition(f),
            before = coins(f.state())
        for (const guid of ids) f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: guid })
        assert.equal(coins(f.state()), before)
        assert.deepEqual(f.state().home.ranches[201].stores, [{ itemtype: 10, itemid: 103, itemnum: 5500 }])
        assert.equal(ranchStoredSlots(f.state().home.ranches[201].stores, f.tables), 1)
        const packets = f.call('RanchGetStoreReward', { u32: 201 })
        assert.equal(coins(f.state()), before + 5500n)
        const ack = packets.find((packet) => packet.id === 6163)
        assert.deepEqual(
            f.protocol
                .decode('Rewards', ack.payload)
                .rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
            [{ itemtype: 10, itemid: 103, itemnum: 5500 }],
        )
        assert(packets.findIndex((packet) => packet.id === 5008) < packets.findIndex((packet) => packet.id === 6163))
        assert(packets.findIndex((packet) => packet.id === 6102) < packets.findIndex((packet) => packet.id === 6163))
        assert.throws(() => f.call('RanchGetStoreReward', { u32: 201 }), { code: ErrorCode.HomeRanchStoreIsNull })
        f.reopen()
        assert.equal(coins(f.state()), before + 5500n)
    } finally {
        try {
            f.close()
        } finally {
            temp.close()
        }
    }
})
test('typed stored amount overflow and later malformed warehouse row preserve the original floor source and wallet', () => {
    const f = ranchBonusFixture('typed-ranch-invalid')
    try {
        const [guid] = storedCurrencyPrecondition(f, [500])
        f.edit((state) => {
            state.home.ranches[201].stores = [{ itemtype: 10, itemid: 103, itemnum: 0xffffffff }]
        })
        let before = f.store.load(f.session.id)
        assert.throws(() => f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: guid }), {
            code: ErrorCode.GameConfig,
        })
        assert.deepEqual(f.store.load(f.session.id), before)
        f.edit((state) => {
            state.home.ranches[201].stores = [
                { itemtype: 10, itemid: 103, itemnum: 500 },
                { itemtype: 3, itemid: 999999999, itemnum: 1 },
            ]
        })
        before = f.store.load(f.session.id)
        assert.throws(() => f.call('RanchGetStoreReward', { u32: 201 }), /Unknown reward item/)
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
