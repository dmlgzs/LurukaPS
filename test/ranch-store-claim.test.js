import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchFixture } from './ranch-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

function storeProduction(f) {
    f.assign()
    f.store.transact(f.session.id, 0, (s) => {
        s.pets.find((p) => p.guid === f.pets[1]).labor_infos = [{ labor_id: 9, labor_grade: 1 }]
    })
    f.assign(f.pets[1], 0, 2)
    f.elapse(360)
    f.tick()
    const drops = f.state().home.ranches[201].drops
    for (const drop of drops) f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: drop.guid })
    return drops
}
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
const claim = (f) => f.call('RanchGetStoreReward', { u32: 201 })

test('6163 completes the real production/harvester/storage chain and grants inventory before its Rewards reply', () => {
    const f = ranchFixture('ranch-store-claim')
    try {
        const drops = storeProduction(f),
            before = f.state()
        const out = claim(f),
            response = f.protocol.decode('Rewards', out.find((p) => p.id === 6163).payload)
        assert.equal(response.src, 77)
        assert.equal(response.rewards.length, drops.length)
        assert(out.findIndex((p) => p.id === 5008) < out.findIndex((p) => p.id === 6163))
        assert(out.findIndex((p) => p.id === 6102) < out.findIndex((p) => p.id === 6163))
        assert(out.some((p) => p.id === 5008))
        assert(out.some((p) => p.id === 6102))
        for (const drop of drops)
            assert.equal(stock(f.state(), drop.item.itemid), stock(before, drop.item.itemid) + drop.item.itemnum)
        assert.deepEqual(f.state().home.ranches[201].stores, [])
        const after = f.store.load(f.session.id)
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.HomeRanchStoreIsNull,
        )
        assert.deepEqual(f.store.load(f.session.id), after)
        f.call('EnterGame', { open_id: 'ranch-store-claim' }, {})
        assert.deepEqual(f.state().home.ranches[201].stores, [])
        for (const drop of drops) assert.equal(stock(f.state(), drop.item.itemid), stock(after.state, drop.item.itemid))
    } finally {
        f.close()
    }
})
test('stored rewards can be claimed after removing the harvesting worker and future production remains collectible', () => {
    const f = ranchFixture('ranch-store-withdrawn')
    try {
        storeProduction(f)
        f.call('RanchSetPetOption', { block_id: 201, slot: 0, pet_guid: '0', work_type: 2, out_hub: true })
        assert.equal(f.state().home.ranches[201].harvest_pet, '0')
        claim(f)
        f.store.transact(f.session.id, 0, (s) => {
            s.pets.find((p) => p.guid === f.pets[1]).labor_infos = [{ labor_id: 9, labor_grade: 1 }]
        })
        f.assign(f.pets[1], 0, 2)
        f.elapse(360)
        f.tick()
        for (const drop of f.state().home.ranches[201].drops)
            f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: drop.guid })
        const out = claim(f)
        assert(f.protocol.decode('Rewards', out.find((p) => p.id === 6163).payload).rewards.length > 0)
    } finally {
        f.close()
    }
})
test('a later corrupt stored item and reward-response encoding failure roll back every credit and the warehouse', () => {
    const f = ranchFixture('ranch-store-rollback')
    try {
        const drops = storeProduction(f)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.ranches[201].stores.push({ itemtype: 3, itemid: 999999999, itemnum: 1 })
        })
        let before = f.store.load(f.session.id)
        assert.throws(() => claim(f), /Unknown reward item/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.ranches[201].stores.pop()
        })
        before = f.store.load(f.session.id)
        const encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name === 'cs.Rewards' || name === 'Rewards') throw Error('warehouse response failed')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => claim(f), /warehouse response failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.protocol.encode = encode
        claim(f)
        for (const drop of drops) assert(stock(f.state(), drop.item.itemid) >= drop.item.itemnum)
    } finally {
        f.close()
    }
})
