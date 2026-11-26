import { WorldObjectCatalog } from '../src/world-objects.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { giveAllRewards } from '../src/give-all.js'
import { MallCatalog } from '../src/mall.js'
import { parseRewards } from '../src/rewards.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
function fixture(options = {}) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, options),
        session = {}
    let seq = 1
    let observer
    const send = (s, n, r = {}) => {
        const e = protocol.byName.get('CSProto' + n)
        const packets = game.dispatch(s, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
        observer?.(packets)
        return packets.map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    send(session, 'EnterGame', { open_id: 'inventory-test' })
    return {
        store,
        session,
        send,
        call: (n, r) => send(session, n, r),
        state: () => store.load(session.id).state,
        observe: (fn) => {
            observer = fn
        },
    }
}
const gm = (s) => ({ command: Buffer.from(s).toString('base64') })
test('legacy missing/duplicate bag GUIDs are repaired on login without losing counts', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.sbag_infos.items = [
                { itemid: 300000, itemnum: 7 },
                { itemid: 400001, itemnum: 4, guid: '0' },
                { itemid: 1000002, itemnum: 2, guid: '17' },
                { itemid: 1520001, itemnum: 0, guid: '17' },
            ]
        })
        const login = f.send({}, 'EnterGame', { open_id: 'inventory-test' }),
            bag = login.find((p) => p.id === 5001).data.data.sbag_infos.items
        assert.equal(new Set(bag.map((i) => i.guid)).size, 4)
        assert(bag.every((i) => BigInt(i.guid) > 0n))
        assert.deepEqual(
            bag.map((i) => i.itemnum),
            [7, 4, 2, 0],
        )
        assert.equal(bag[2].guid, '17')
        const saved = f.state().player.sbag_infos.items
        f.send({}, 'EnterGame', { open_id: 'inventory-test' })
        assert.deepEqual(f.state().player.sbag_infos.items, saved)
    } finally {
        f.store.close()
    }
})
test('giveall grants catalog items with distinct client GUID keys and preserves upgraded equipment', () => {
    // This case starts with owned equipment to verify upgrading/preservation.
    // Use the trusted sandbox factory explicitly; the other cases stay normal.
    const f = fixture({ starterProfile: 'sandbox' })
    try {
        let missing
        f.store.transact(f.session.id, 0, (s) => {
            missing = s.player.soulessence_infos.soulessences.pop().id
            s.player.soulessence_infos.soulessences[0].rank = 3
        })
        const packets = f.call('GMCommand', gm('giveall')),
            state = f.state(),
            bag = state.player.sbag_infos.items
        assert.equal(bag.length, tables.get('common_item').length)
        assert.equal(new Set(bag.map((i) => i.guid)).size, bag.length)
        assert(bag.every((i) => [1, 999].includes(i.itemnum)))
        assert.equal(bag.find((i) => i.itemid === 112001).itemnum, 1)
        assert.equal(bag.find((i) => i.itemid === 300000).itemnum, 999)
        assert.equal(state.player.soulessence_infos.soulessences[0].rank, 3)
        assert(state.player.soulessence_infos.soulessences.some((e) => e.id === missing))
        const syncs = packets.filter((p) => p.data.sbag_infos)
        assert.equal(syncs.length, 1)
        assert.equal(packets[0], syncs[0])
        const client = new Map(syncs[0].data.sbag_infos.items.map((i) => [i.guid, i]))
        assert.equal(client.size, bag.length)
        const ids = bag.map((i) => i.guid),
            quantities = bag.map((i) => i.itemnum)
        f.call('GMCommand', gm('giveall'))
        assert.deepEqual(
            f.state().player.sbag_infos.items.map((i) => i.guid),
            ids,
        )
        assert.deepEqual(
            f.state().player.sbag_infos.items.map((i) => i.itemnum),
            quantities.map((n) => (n === 1 ? 1 : 1998)),
        )
    } finally {
        f.store.close()
    }
})
test('nonstackable catalog rules choose one and invalid GM batches roll back giveall', () => {
    const fake = {
        get: (n) =>
            n === 'common_item'
                ? [
                      { id: 1, stackNum: 1, maxNum: 0 },
                      { id: 2, stackNum: 0, maxNum: 1 },
                      { id: 3, stackNum: 0, maxNum: 0 },
                  ]
                : [],
    }
    assert.deepEqual(
        giveAllRewards(fake, { player: { soulessence_infos: { soulessences: [] } } }).map((r) => r.itemnum),
        [1, 1, 999],
    )
    const f = fixture()
    try {
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('GMCommands', { cmds: [gm('giveall'), gm('invalid')] }))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('collection, chest and mall share committed GUID inventory sync before reward presentation', (t) => {
    const f = fixture({ rng: () => 0, clock: () => 1800000000 }),
        world = new WorldObjectCatalog(tables),
        mall = new MallCatalog(tables),
        client = new ObtInventoryConsumer(tables, protocol)
    try {
        assert.equal(f.state().starterProfile.mode, 'normal')
        assert(!(f.state().player.basic_info.lock_system ?? []).includes(92))
        const checkInventory = () => {
            const expected = f.state().player.sbag_infos.items.filter((item) => item.itemnum > 0)
            assert.equal(client.items.size, expected.length)
            assert.equal(new Set(expected.map((item) => item.guid)).size, expected.length)
            for (const item of expected) {
                assert(BigInt(item.guid) > 0n)
                const cached = client.items.get(item.guid)
                assert(cached, 'Reward callback cannot resolve the committed bag GUID')
                assert.equal(cached.itemid, item.itemid)
                assert.equal(cached.itemnum, item.itemnum)
            }
        }
        let batch = [],
            presentations = 0
        f.observe((packets) => {
            batch = packets
            client.consumePackets(packets)
        })
        f.send({}, 'EnterGame', { open_id: 'inventory-test' })
        checkInventory()
        const present = (name, readRewards, verify) => {
            client.onAck(name, (_cache, response) => {
                const ackId = protocol.byName.get('CSProto' + name).id,
                    syncs = batch.filter((packet) => {
                        const entry = protocol.byId.get(packet.id)
                        return !!protocol.decode(entry.rsp, packet.payload).sbag_infos
                    })
                assert.equal(syncs.length, 1)
                assert.equal(batch[0], syncs[0])
                assert(batch.indexOf(syncs[0]) < batch.findIndex((packet) => packet.id === ackId))
                checkInventory()
                const rewards = readRewards(response)
                assert(rewards.length)
                assert(rewards.some((reward) => reward.itemtype === 3))
                for (const reward of rewards.filter((reward) => reward.itemtype === 3))
                    assert(client.count(reward.itemid) >= reward.itemnum)
                verify?.(response, rewards)
                presentations++
            })
        }

        // Current main-world data, not the retired map101 objects. The simple
        // collection action10016 reaches BreakItemComponent.OnRewardResult
        // 060083d4 -> MapService.TryInteractObject060288b5/b6, complete=true.
        const collection = world.object(100, 200874),
            collecting = tables
                .get('world_collecting')
                .find((row) => String(row.spawnerId).split('|').map(Number).includes(collection.spawner.id)),
            chest = world.object(100, 400358)
        assert.equal(collection.spawner.objectType, 12)
        assert.equal(collecting.itemType, 3)
        assert(tables.find('common_item', collecting.itemId))
        assert(
            String(collection.spawner.interactOps)
                .split('|')
                .some((id) => tables.find('world_interact', Number(id))?.interactAction === 10016),
        )
        assert.equal(chest.spawner.objectType, 35)
        assert(chest.row.statusReward)
        for (const source of [collection, chest]) {
            assert.equal(source.row.initStatus, 0)
            assert.equal(source.row.initialCompleteState, 0)
            assert(!source.row.appearCond && !source.row.disappearCond)
            // Trusted location checkpoint at the real object's coordinates;
            // no injected rewards, completion records or altered range policy.
            f.store.transact(f.session.id, 0, (s) => {
                s.world.map_id = source.row.cityId
                s.world.pos = structuredClone(source.pos)
            })
            const before = client.count(collecting.itemId)
            const oldGuids = new Map(f.state().player.sbag_infos.items.map((item) => [item.itemid, item.guid]))
            present(
                'WorldObjInteract',
                (response) => response.objs[0].rewards.rewards,
                (_response, rewards) => {
                    if (source === collection) {
                        assert.deepEqual(
                            rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
                            [{ itemtype: collecting.itemType, itemid: collecting.itemId, itemnum: 1 }],
                        )
                        assert.equal(client.count(collecting.itemId), before + 1)
                    }
                },
            )
            const request = {
                objs: [
                    {
                        obj: { obj_id: source.row.id, complete: true, state_data: {} },
                        interact_type: source === collection ? 2 : 0,
                    },
                ],
            }
            f.call('WorldObjInteract', request)
            for (const item of f.state().player.sbag_infos.items)
                if (oldGuids.has(item.itemid)) assert.equal(item.guid, oldGuids.get(item.itemid))
            const saved = structuredClone(f.state().player.sbag_infos)
            const retry = f.call('WorldObjInteract', request)
            assert.equal(
                retry.find((packet) => packet.id === protocol.byName.get('CSProtoWorldObjInteract').id).data.objs[0]
                    .rewards.rewards.length,
                0,
            )
            assert.deepEqual(f.state().player.sbag_infos, saved)
            checkInventory()
        }

        // Select an actual unconditionally available diamond good through the
        // current shop/goods FK. 18031 displays diamond_rewards directly;
        // 18048 is the separate recharge/pay popup contract.
        const goods = [...mall.diamond.values()].find((row) => {
            const costs = parseRewards(row.costId),
                rewards = parseRewards(row.item)
            return (
                !row.commonCondition &&
                !row.timelimit &&
                !row.specialPrice &&
                !row.autoOpen &&
                costs.length === 1 &&
                costs[0].itemtype === 10 &&
                costs[0].itemid === 1 &&
                costs[0].itemnum > 0 &&
                rewards.length > 0 &&
                rewards.every((reward) => reward.itemtype === 3) &&
                [...mall.shops.values()].some(
                    (shop) =>
                        !shop.unlockCondition &&
                        !shop.timelimit &&
                        String(shop.goodsList).split('|').map(Number).includes(row.goodsId),
                )
            )
        })
        assert(goods)
        const shop = [...mall.shops.values()].find(
                (row) =>
                    !row.unlockCondition &&
                    !row.timelimit &&
                    String(row.goodsList).split('|').map(Number).includes(goods.goodsId),
            ),
            cost = parseRewards(goods.costId)[0].itemnum,
            output = parseRewards(goods.item)
        // Trusted saved-wallet baseline; the item/reward producer is still the
        // actual purchase handler, with no GM grant or manually inserted item.
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.diamond = cost + 37
        })
        f.send({}, 'EnterGame', { open_id: 'inventory-test' })
        assert.equal(client.basic.diamond, cost + 37)
        const counts = new Map(output.map((reward) => [reward.itemid, client.count(reward.itemid)]))
        const oldGuids = new Map(f.state().player.sbag_infos.items.map((item) => [item.itemid, item.guid]))
        present(
            'PlayerMallBuyDiamondGoods',
            (response) => response.diamond_rewards.rewards,
            (response, rewards) => {
                assert.equal(response.diamond_shop_id, shop.shopId)
                assert.equal(response.diamond_goods.goods_id, goods.goodsId)
                assert.equal(response.diamond_goods.curr_purchase_num, 1)
                assert.deepEqual(
                    rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
                    output,
                )
                assert.equal(client.basic.diamond, 37)
                for (const reward of output)
                    assert.equal(client.count(reward.itemid), counts.get(reward.itemid) + reward.itemnum)
            },
        )
        const purchase = f.call('PlayerMallBuyDiamondGoods', {
            diamond_shop_id: shop.shopId,
            diamond_goods_id: goods.goodsId,
            buy_count: 1,
        })
        assert(!purchase.some((packet) => packet.id === 18048))
        for (const item of f.state().player.sbag_infos.items)
            if (oldGuids.has(item.itemid)) assert.equal(item.guid, oldGuids.get(item.itemid))
        assert.equal(f.state().player.basic_info.diamond, 37)
        assert.equal(presentations, 3)
        const before = structuredClone(f.state().player.sbag_infos)
        f.send({}, 'EnterGame', { open_id: 'inventory-test' })
        assert.deepEqual(f.state().player.sbag_infos, before)
        checkInventory()
        t.diagnostic(
            JSON.stringify({
                map: collection.row.cityId,
                collecting: {
                    object: collection.row.id,
                    spawner: collection.spawner.id,
                    config: collecting.id,
                    item: collecting.itemId,
                },
                chest: { object: chest.row.id, spawner: chest.spawner.id, drops: chest.row.statusReward },
                mall: { shop: shop.shopId, goods: goods.goodsId, diamondCost: cost, rewards: output },
                presentations,
                bagGuids: before.items.map((item) => ({ guid: item.guid, item: item.itemid, count: item.itemnum })),
            }),
        )
    } finally {
        f.store.close()
    }
})
