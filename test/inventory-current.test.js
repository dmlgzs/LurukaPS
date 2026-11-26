import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ShopCatalog } from '../src/shops.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base),
    now = 1800000000
function fixture(name) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {},
        client = new ObtInventoryConsumer(tables, protocol)
    let seq = 1
    const call = (name, request = {}, consumer = client, target = session, requestSeq = seq++) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, `Current request is not registered: ${name}`)
        const packets = game.dispatch(target, {
            id: entry.id,
            seq: requestSeq,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
        consumer?.consumePackets(packets)
        return packets
    }
    const login = () => {
        const next = new ObtInventoryConsumer(tables, protocol)
        call('EnterGame', { open_id: `inventory-current-${name}`, reconnect: true }, next, {})
        return next
    }
    call('EnterGame', { open_id: `inventory-current-${name}` })
    return {
        store,
        client,
        call,
        login,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
    }
}
function seed(f, rewards) {
    f.edit((state) => grantRewards(tables, state, rewards))
    const client = f.login()
    Object.assign(f.client, client)
}
function qualifyFavorHeroes(f, count) {
    // These endpoints test gifts/equipment on acquired heroes. Keep the
    // account normal and grant only the recipients this vector requires.
    const eligible = tables.get('hero').filter((row) => row.isUsable === 1 && row.favor === 1)
    const furnitureHero = tables
        .get('home_dorm_furniture')
        .map((row) => eligible.find((hero) => hero.id === row.heroId))
        .find(Boolean)
    assert(furnitureHero)
    const chosen = [furnitureHero, ...eligible.filter((hero) => hero.id !== furnitureHero.id)].slice(0, count)
    assert.equal(chosen.length, count)
    seed(
        f,
        chosen.map((hero) => ({ itemtype: 1, itemid: hero.id, itemnum: 1 })),
    )
}
const heroById = (f, id) => f.state().player.heros_info.heros.find((hero) => hero.conf_id === id)
const heroPair = (f) =>
    f
        .state()
        .player.heros_info.heros.filter((hero) => tables.find('hero', hero.conf_id)?.favor === 1)
        .slice(0, 2)
const moduleAttributes = (client, guid, type) =>
    client.battle
        .get(guid)
        .modules.find((module) => module.module_type === type)
        .sub_modules.find((sub) => sub.sub_module_id === 0).attrs.attrs

test('current6030/6039 selectable-box requests keep each choice, update inventory before reward callbacks and delete depleted stacks', () => {
    const f = fixture('box')
    try {
        const box = tables.get('common_item').find((row) => {
            if (row.useType !== 3 || !row.giftBagReward) return false
            const choices = parseRewards(row.giftBagReward)
            return (
                choices.length >= 2 &&
                choices.every((choice) => choice.itemtype === 3 && tables.find('common_item', choice.itemid))
            )
        })
        assert(box)
        const [first, second] = parseRewards(box.giftBagReward)
        seed(f, [{ itemtype: 3, itemid: box.id, itemnum: 3 }])
        const firstCount = f.client.count(first.itemid),
            secondCount = f.client.count(second.itemid)
        const single = { itemid: box.id, num: 1, args: [first.itemtype, first.itemid] }
        f.client.onAck('UseItem', (client, reward) => {
            assert.equal(client.count(box.id), 2)
            assert.equal(client.count(first.itemid), firstCount + first.itemnum)
            assert(reward.rewards.some((row) => row.itemid === first.itemid))
        })
        f.call('UseItem', single)
        const beforeInvalid = structuredClone(f.state().player.sbag_infos)
        assert.throws(() => f.call('UseItem', { ...single, args: [3, 0xffffffff] }), /not in this gift/)
        assert.deepEqual(f.state().player.sbag_infos, beforeInvalid)
        f.client.onAck('BatchUseItem', (client, reward) => {
            assert.equal(client.count(box.id), 0)
            assert.equal(client.count(first.itemid), firstCount + first.itemnum * 2)
            assert.equal(client.count(second.itemid), secondCount + second.itemnum)
            assert(reward.rewards.some((row) => row.itemid === second.itemid))
        })
        f.call('BatchUseItem', { items: [single, { ...single, args: [second.itemtype, second.itemid] }] })
        const logged = f.login()
        assert.equal(logged.count(box.id), 0)
        assert.equal(logged.count(first.itemid), firstCount + first.itemnum * 2)
        assert.equal(logged.count(second.itemid), secondCount + second.itemnum)
        assert.throws(() => f.call('UseItem', single), /Insufficient items/)
    } finally {
        f.store.close()
    }
})

test('current6610 normal and furniture gifts consume the bag before the callback reads updated favor; retries and relog agree', () => {
    const f = fixture('gift')
    try {
        qualifyFavorHeroes(f, 1)
        const furniture = tables.get('home_dorm_furniture').find((row) => heroById(f, row.heroId))
        assert(furniture)
        const gift = tables
            .get('hero_favorability_gift')
            .find((row) => String(row.favourHero).split('|').map(Number).includes(furniture.heroId))
        assert(gift)
        f.edit((state) => {
            const hero = state.player.heros_info.heros.find((hero) => hero.conf_id === furniture.heroId)
            hero.favorability_lv = 1
            hero.favorability_exp = 0
            hero.daily_gift_num = 0
            hero.furnitures = []
        })
        seed(f, [
            { itemtype: 3, itemid: gift.id, itemnum: 3 },
            { itemtype: 3, itemid: furniture.id, itemnum: 1 },
        ])
        const before = f.client.favor(furniture.heroId),
            request = { heroId: furniture.heroId, item_id: gift.id, item_type: 110, num: 2 }
        f.client.onAck('SendHeroGift', (client, data) => {
            assert.equal(data.hero_id, furniture.heroId)
            assert.equal(data.item_type, 110)
            assert.equal(client.count(gift.id), 1)
            assert.equal(client.favor(furniture.heroId) - before, gift.favourValue * 2)
        })
        f.call('SendHeroGift', request, f.client, undefined, 991)
        const spent = f.state().heroGiftProgress.total
        f.call('SendHeroGift', request, f.client, undefined, 991)
        assert.equal(f.state().heroGiftProgress.total, spent)
        assert.equal(f.client.count(gift.id), 1)
        const favor = f.client.favor(furniture.heroId)
        f.client.onAck('SendHeroGift', (client) => {
            assert.equal(client.count(furniture.id), 0)
            assert.equal(client.favor(furniture.heroId), favor + furniture.value)
            assert(client.heroes.get(heroById(f, furniture.heroId).guid).furnitures.includes(furniture.id))
        })
        f.call('SendHeroGift', { heroId: furniture.heroId, item_id: furniture.id, item_type: 111, num: 1 })
        assert.throws(() => f.call('SendHeroGift', { ...request, item_type: 3 }), /gift category/)
        assert.throws(
            () => f.call('SendHeroGift', { heroId: furniture.heroId, item_id: furniture.id, item_type: 111, num: 1 }),
            /already been given/,
        )
        const logged = f.login()
        assert.equal(logged.favor(furniture.heroId), f.client.favor(furniture.heroId))
        assert.equal(logged.count(gift.id), 1)
        assert.equal(logged.count(furniture.id), 0)
    } finally {
        f.store.close()
    }
})

test('current6046 spirit transfer refreshes both ownership caches and battle modules before the equip callback', () => {
    const f = fixture('soul')
    try {
        qualifyFavorHeroes(f, 2)
        const [first, second] = heroPair(f)
        assert(first && second)
        const definition = tables.get('soulessence').find((row) => !row.validProfession)
        assert(definition)
        seed(f, [{ itemtype: 9, itemid: definition.id, itemnum: 1 }])
        const soul = f.state().player.soulessence_infos.soulessences.find((row) => row.id === definition.id)
        const count = f.state().player.soulessence_infos.soulessences.length
        const initial = JSON.stringify(f.client.battle.get(first.guid)?.modules)
        f.client.onAck('MoveSoulEssence', (client) => {
            client.equipment(first.guid)
            assert.equal(client.heroes.get(first.guid).wguid, soul.guid)
            assert(moduleAttributes(client, first.guid, 1).some((attribute) => BigInt(attribute.attr_val) > 0n))
            assert.notEqual(JSON.stringify(client.battle.get(first.guid).modules), initial)
        })
        f.call('MoveSoulEssence', { hero_id: first.guid, guid: soul.guid })
        f.client.onAck('MoveSoulEssence', (client) => {
            assert.equal(client.heroes.get(first.guid).wguid, 0)
            assert.equal(moduleAttributes(client, first.guid, 1).length, 0)
            client.equipment(second.guid)
        })
        const request = { hero_id: second.guid, guid: soul.guid }
        f.call('MoveSoulEssence', request)
        f.call('MoveSoulEssence', request)
        assert.equal(f.state().player.soulessence_infos.soulessences.length, count)
        const logged = f.login()
        logged.equipment(second.guid)
        assert.equal(logged.heroes.get(first.guid).wguid, 0)
        f.call('MoveSoulEssence', { hero_id: second.guid, guid: 0 })
        assert.equal(f.client.souls.get(String(soul.guid)).wear_hero, '0')
        assert.equal(f.client.heroes.get(second.guid).wguid, 0)
        assert.equal(moduleAttributes(f.client, second.guid, 1).length, 0)
        assert.throws(() => f.call('MoveSoulEssence', { hero_id: second.guid, guid: 0xffffffff }), /not owned/)
    } finally {
        f.store.close()
    }
})

test('current6020 and6027 accessory transfer and removal update the cache and effective battle modules before callbacks', () => {
    const f = fixture('accessory')
    try {
        qualifyFavorHeroes(f, 2)
        const [first, second] = heroPair(f)
        const custom = tables
            .get('accessory_customed')
            .find((row) => tables.find('accessory', row.accessoryId)?.mainAttr)
        seed(f, [{ itemtype: 33, itemid: custom.id, itemnum: 1 }])
        const ornament = f.state().ornaments[0],
            definition = tables.find('accessory', ornament.id),
            slot = definition.type - 1,
            before = JSON.stringify(f.client.battle.get(first.guid)?.modules)
        f.client.onAck('MoveOrnament', (client) => {
            client.equipment(first.guid)
            assert.equal(client.heroes.get(first.guid).oguid[slot], ornament.guid)
            assert(moduleAttributes(client, first.guid, 2).some((attribute) => BigInt(attribute.attr_val) > 0n))
            assert.notEqual(JSON.stringify(client.battle.get(first.guid).modules), before)
        })
        f.call('MoveOrnament', { hero_id: first.guid, ornament_guid: ornament.guid })
        f.client.onAck('MoveOrnament', (client) => {
            client.equipment(second.guid)
            assert.equal(client.heroes.get(first.guid).oguid[slot], 0)
            assert.equal(moduleAttributes(client, first.guid, 2).length, 0)
        })
        const request = { hero_id: second.guid, ornament_guid: ornament.guid }
        f.call('MoveOrnament', request)
        f.call('MoveOrnament', request)
        assert.equal(f.state().ornaments.length, 1)
        f.login().equipment(second.guid)
        f.client.onAck('RemoveOrnament', (client) => {
            assert.equal(client.heroes.get(second.guid).oguid[slot], 0)
            assert.equal(client.ornaments.get(String(ornament.guid)).wear_hero, '0')
            assert.equal(moduleAttributes(client, second.guid, 2).length, 0)
        })
        f.call('RemoveOrnament', { hero_id: second.guid, type: definition.type })
        assert.throws(() => f.call('MoveOrnament', { ...request, ornament_guid: 0xffffffff }), /not owned/)
    } finally {
        f.store.close()
    }
})

test('current6070/6071 shop flow uses actual slot and goods references, spends currency, grants items and retains finite stock on relog', () => {
    const f = fixture('shop')
    try {
        const catalog = new ShopCatalog(tables),
            state = f.state()
        let selected
        for (const shop of tables.get('shop')) {
            try {
                const info = catalog.info(shop.shopId, state, now)
                const slot = info.shop_items.find((slot) => {
                    const goods = tables.get('goods').find((goods) => goods.goodsId === slot.goods_id)
                    return (
                        goods.goodsNum > 1 &&
                        !goods.autoOpen &&
                        !goods.commonCondition &&
                        /^3#\d+#\d+$/.test(goods.item) &&
                        /^10#\d+#\d+$/.test(goods.costId)
                    )
                })
                if (slot) {
                    selected = {
                        shop,
                        slot,
                        goods: tables.get('goods').find((goods) => goods.goodsId === slot.goods_id),
                    }
                    break
                }
            } catch {}
        }
        assert(selected, 'No current ordinary-shop route is reachable')
        const { shop, slot, goods } = selected,
            [payment] = parseRewards(goods.costId),
            [reward] = parseRewards(goods.item)
        seed(f, [{ ...payment, itemnum: payment.itemnum * (goods.goodsNum + 1) }])
        f.call('ShopInfoReq', { shop_id: shop.shopId })
        assert.equal(f.client.shops.get(shop.shopId).slots.get(slot.slot_id).goods_id, goods.goodsId)
        const before = f.client.count(reward.itemid),
            currency = f.client.attributes.get(payment.itemid),
            request = { shop_id: shop.shopId, items: [{ slot_id: slot.slot_id, goods_id: goods.goodsId, times: 1 }] }
        f.client.onAck('ShopBuyItems', (client, response) => {
            assert.equal(response.shop_id, shop.shopId)
            assert.equal(client.count(reward.itemid), before + reward.itemnum)
            assert.equal(client.attributes.get(payment.itemid), currency - BigInt(payment.itemnum))
            // shopAction emits onBuyShopGoodsSucc after the successful callback;
            // the shop refresh push itself is allowed to follow that callback.
        })
        f.call('ShopBuyItems', request)
        assert.equal(f.client.shops.get(shop.shopId).slots.get(slot.slot_id).buy_times, 1)
        f.call('ShopBuyItems', request)
        assert.equal(f.client.shops.get(shop.shopId).slots.get(slot.slot_id).buy_times, 2)
        const logged = f.login()
        f.call('ShopInfoReq', { shop_id: shop.shopId }, logged)
        assert.equal(logged.shops.get(shop.shopId).slots.get(slot.slot_id).buy_times, 2)
        assert.equal(logged.count(reward.itemid), before + reward.itemnum * 2)
        const snapshot = structuredClone(f.state().player)
        assert.throws(
            () => f.call('ShopBuyItems', { ...request, items: [{ ...request.items[0], times: goods.goodsNum }] }),
            /limit exceeded/,
        )
        assert.deepEqual(f.state().player, snapshot)
        assert.throws(
            () => f.call('ShopBuyItems', { ...request, items: [{ ...request.items[0], goods_id: 0xffffffff }] }),
            /Wrong goods/,
        )
    } finally {
        f.store.close()
    }
})

test('the current cache model catches ACK-before-sync, unresolved equipment definitions and zero-stack deletion', () => {
    const client = new ObtInventoryConsumer(tables, protocol),
        hero = { guid: '1', conf_id: tables.get('hero').find((hero) => hero.isUsable === 1).id, wguid: 123, oguid: [] }
    client.player({ heros_info: { heros: [hero] } })
    assert.throws(() => client.equipment(hero.guid), /cannot resolve soul/)
    client.player({ soulessence_infos: { soulessences: [{ guid: 123, id: 0xffffffff, wear_hero: hero.guid }] } })
    assert.equal(client.souls.size, 0, 'The actual consumer skips missing soul table rows')
    assert.throws(() => client.equipment(hero.guid), /cannot resolve soul/)
    const id = tables.get('common_item')[0].id
    client.player({ sbag_infos: { items: [{ guid: '99', itemid: id, itemnum: 4 }] } })
    assert.equal(client.count(id), 4)
    client.player({ sbag_infos: { items: [{ guid: '99', itemid: id, itemnum: 0 }] } })
    assert.equal(client.count(id), 0)
    const gift = tables.get('hero_favorability_gift')[0]
    client.player({
        heros_info: {
            heros: [
                { guid: '2', conf_id: Number(gift.favourHero.split('|')[0]), favorability_lv: 1, favorability_exp: 0 },
            ],
        },
    })
    const before = client.favor(Number(gift.favourHero.split('|')[0]))
    client.onAck('SendHeroGift', (cache) =>
        assert.equal(cache.favor(Number(gift.favourHero.split('|')[0])) - before, gift.favourValue),
    )
    const entry = protocol.byName.get('CSProtoSendHeroGift')
    assert.throws(
        () =>
            client.consumePackets([
                {
                    id: entry.id,
                    payload: protocol.encode(entry.rsp, {
                        hero_id: Number(gift.favourHero.split('|')[0]),
                        item_id: gift.id,
                        item_type: 110,
                        num: 1,
                    }),
                },
            ]),
        /Expected values/,
    )
})
