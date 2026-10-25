import test from 'node:test'
import assert from 'node:assert/strict'
import { multiCollectionFixture, protocol, build, extra, stock, product } from './collection-multi-item-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('6554 independently grants both actual10087 random candidate identities with one shared collection award', () => {
    const f = multiCollectionFixture()
    try {
        let draws = 0
        f.game.rng = (min, max) => (min === 0 && max === 2 ? draws++ % 2 : min)
        f.advance(3600)
        assert.equal(
            extra(f.state()).reduce((n, item) => n + item.item_num, 0),
            10,
        )
        const before = f.state(),
            out = f.call('GetAllBuildReward', { build_guid: [100] }).find((p) => p.id === 6554).data,
            rewards = out.base.find((row) => row.type === 24).award.rewards
        for (const id of [306000, 306004]) {
            const amount = build(before)
                .collect_build_data.items.filter((row) => row.item_id === id && row.item_type === 3)
                .reduce((n, row) => n + row.item_num, 0)
            assert.equal(rewards.find((row) => row.itemid === id && row.itemtype === 3).itemnum, amount)
            assert.equal(stock(f.state(), id) - stock(before, id), amount)
        }
        assert.deepEqual(build(f.state()).collect_build_data.items, [])
        assert.deepEqual(f.call('GetAllBuildReward', { build_guid: [100] }).find((p) => p.id === 6554).data.base, [])
    } finally {
        f.close()
    }
})

test('6554 verifies random-pool membership and failed aggregate ACK restores every warehouse and awarded item', () => {
    const f = multiCollectionFixture()
    try {
        f.game.rng = (min, max) => (min === 0 && max === 2 ? 1 : min)
        f.advance(360)
        const before = f.state(),
            encode = protocol.encode,
            replyType = protocol.byName.get('CSProtoGetAllBuildReward').rsp
        protocol.encode = function (name, ...args) {
            if (name === replyType) throw Error('multi aggregate ACK')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.call('GetAllBuildReward', { build_guid: [100] }), /multi aggregate ACK/)
            assert.deepEqual(f.state(), before)
        } finally {
            protocol.encode = encode
        }
        f.edit((state) =>
            build(state).collect_build_data.items.push({
                item_id: 300000,
                item_type: 3,
                item_num: 1,
                source_product_id: product,
            }),
        )
        const corrupt = f.state()
        assert.throws(
            () => f.call('GetAllBuildReward', { build_guid: [100] }),
            (error) => error.code === ErrorCode.CollectProductnotMatch,
        )
        assert.deepEqual(f.state(), corrupt)
    } finally {
        f.close()
    }
})
