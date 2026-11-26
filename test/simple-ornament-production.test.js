import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { productionTables } from '../src/production-tables.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

test('current11010 queues actual quick ornaments and synchronizes GUID instances before reward presentation', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        current = productionTables(tables),
        protocol = new Protocol(cfg.base)
    const store = new Store(':memory:')
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    const count = (id) =>
        state()
            .player.sbag_infos.items.filter((row) => row.itemid === id)
            .reduce((n, row) => n + row.itemnum, 0)
    try {
        call('EnterGame', { open_id: 'quick-ornament' })
        const recipes = current
            .get('products')
            .filter((row) => row.isQuickProduct === 1 && parseRewards(row.rewardId).some((x) => x.itemtype === 33))
        assert.equal(recipes.length, 15)
        for (const recipe of recipes)
            for (const reward of parseRewards(recipe.rewardId))
                assert.ok(tables.find('accessory', tables.find('accessory_customed', reward.itemid).accessoryId))
        store.transact(session.id, 0, (s) => {
            s.ornaments = []
            s.player.sbag_infos.items = []
            grantRewards(tables, s, [
                { itemtype: 3, itemid: 300000, itemnum: 30 },
                { itemtype: 3, itemid: 317001, itemnum: 30 },
            ])
        })
        const request = { product_id: 200001, build_guid: 0, count: 1, select_material: [] }
        const before = structuredClone(state())
        for (const bad of [
            { ...request, count: current.find('products', request.product_id).numberLimit + 1 },
            { ...request, product_id: 0xffffffff },
            { ...request, build_guid: 20 },
        ]) {
            assert.throws(
                () => call('SimpleProductStart', bad),
                (error) => error.code === ErrorCode.InvalidArgument,
            )
            assert.deepEqual(state(), before)
        }
        for (const bad of [
            { ...request, ornament_guid: 1 },
            { ...request, designated_item_id: 0xffffffff },
        ]) {
            // Retired11013 fields are absent from the actual11010 request.
            // Keep their rejection at the schema boundary, not a fake ACK.
            assert.throws(() => call('SimpleProductStart', bad), /Unknown field/)
            assert.deepEqual(state(), before)
        }
        const actual = { product_id: 200001, count: 1 }
        assert.equal(
            createHash('sha256')
                .update(protocol.encode(protocol.byName.get('CSProtoSimpleProductStart').req, actual))
                .digest('hex'),
            'fe00b9edd9c5b9f71333ebc07159984376179aa97b4841cda876fa9555310728',
        )
        call('SimpleProductStart', actual)
        assert.equal(count(300000), 20)
        assert.equal(count(317001), 20)
        const job = state().simpleProducts[0]
        now++
        call('SimpleProductStart', request)
        const pending = state().simpleProducts.find((item) => item.guid !== job.guid)
        assert.equal(count(300000), 10)
        assert.equal(count(317001), 10)
        assert.equal(state().ornaments.length, 0)
        now = job.start + job.seconds
        const packets = game.tick(session.id)
        const cacheIndex = packets.findIndex((packet) => packet.id === 6029)
        const finishIndex = packets.findIndex(
            (packet) => packet.id === protocol.byName.get('CSProtoSimpleProductFinish').id,
        )
        assert.ok(cacheIndex >= 0 && cacheIndex < finishIndex)
        const cache = protocol.decode(protocol.byId.get(6029).rsp, packets[cacheIndex].payload)
        const finish = protocol.decode(
            protocol.byName.get('CSProtoSimpleProductFinish').rsp,
            packets[finishIndex].payload,
        )
        assert.equal(cache.ornaments.length, 1)
        assert.equal(finish.reward.rewards[0].itemtype, 15)
        assert.equal(finish.reward.rewards[0].guid, String(cache.ornaments[0].guid))
        assert.equal(finish.reward.rewards[0].itemid, cache.ornaments[0].id)
        call('SimpleProductCancel', { u32: pending.guid })
        assert.equal(count(300000), 20)
        assert.equal(count(317001), 20)
        assert.equal(state().ornaments.length, 1)
        call('SimpleProductCancel', { u32: pending.guid })
        assert.equal(count(300000), 20)
        call('SimpleProductStart', { product_id: 200002, count: 1, select_material: [] })
        now += 10
        const login = call('EnterGame', { open_id: 'quick-ornament' }, {})
        const all = login.find((packet) => packet.id === protocol.byName.get('CSProtoAllEquipOrnamentSync').id)
        assert.equal(protocol.decode(protocol.byId.get(all.id).rsp, all.payload).ornaments.length, 2)
        assert.equal(state().ornaments.length, 2)
        assert.equal(new Set(state().ornaments.map((item) => item.guid)).size, 2)
        assert.deepEqual(state().simpleProducts, [])
        assert.deepEqual(game.tick(session.id), [])
    } finally {
        store.close()
    }
})
