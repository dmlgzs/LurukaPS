import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { cosmeticOwnedCount } from '../src/appearance-rewards.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(name) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, 'current protocol entry ' + name)
        return game
            .dispatch(who, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
            })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    call('EnterGame', { open_id: name })
    return {
        protocol,
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        edit: (callback) => store.transact(session.id, 0, callback),
        advance: (seconds) => {
            now += seconds
        },
        login: () => call('EnterGame', { open_id: name }, {}),
        close: () => store.close(),
    }
}
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((item) => item.itemid === id).reduce((sum, item) => sum + item.itemnum, 0)

test('old11013 quick ornament behavior uses current11010 with real charge, cancel, GUID sync and offline completion', () => {
    const f = fixture('current-quick-ornament-replacement')
    try {
        assert(!f.protocol.byName.has('CSProtoSimpleProductOrnamentStart'))
        assert.equal(f.protocol.byName.get('CSProtoSimpleProductStart').id, 11010)
        const recipes = tables
            .get('products')
            .filter(
                (row) =>
                    row.isQuickProduct === 1 && parseRewards(row.rewardId).some((reward) => reward.itemtype === 33),
            )
        assert.equal(recipes.length, 15)
        f.edit((state) => {
            state.tasks = []
            grantRewards(tables, state, [
                { itemtype: 3, itemid: 300000, itemnum: 30 },
                { itemtype: 3, itemid: 317001, itemnum: 30 },
                { itemtype: 33, itemid: 50002, itemnum: 1 },
            ])
        })
        const old = structuredClone(f.state().ornaments),
            before300 = stock(f.state(), 300000),
            before317 = stock(f.state(), 317001)
        const request = { build_guid: 0, product_id: 200001, count: 1, select_material: [] }
        f.call('SimpleProductStart', request)
        let job = f.state().simpleProducts[0]
        assert.equal(stock(f.state(), 300000), before300 - 10)
        assert.equal(stock(f.state(), 317001), before317 - 10)
        assert.deepEqual(f.state().ornaments, old)
        f.call('SimpleProductCancel', { u32: job.guid })
        assert.equal(stock(f.state(), 300000), before300)
        assert.equal(stock(f.state(), 317001), before317)
        const cancelled = f.state()
        f.call('SimpleProductCancel', { u32: job.guid })
        assert.deepEqual(f.state(), cancelled, 'closed-queue receipt cannot refund twice')
        f.call('SimpleProductStart', request)
        job = f.state().simpleProducts[0]
        f.advance(job.seconds)
        const packets = f.game.tick(f.session.id).map((packet) => ({
            id: packet.id,
            data: f.protocol.decode(f.protocol.byId.get(packet.id).rsp, packet.payload),
        }))
        const cache = packets.findIndex((packet) => packet.id === 6029),
            finish = packets.findIndex((packet) => packet.id === 11014)
        assert(cache >= 0 && cache < finish, 'GUID-instance sync precedes acquired-instance reward notification')
        const created = f.state().ornaments.filter((item) => !old.some((saved) => saved.guid === item.guid))
        assert.equal(created.length, 1)
        assert.equal(created[0].id, tables.find('accessory_customed', 50001).accessoryId)
        const paid = packets[finish].data.reward.rewards.find((reward) => reward.itemtype === 15)
        assert.equal(paid.guid, String(created[0].guid))
        assert.equal(paid.itemid, created[0].id)
        assert.deepEqual(
            f.state().ornaments.filter((item) => old.some((saved) => saved.guid === item.guid)),
            old,
        )
        f.call('SimpleProductStart', { ...request, product_id: 200002 })
        f.advance(tables.find('products', 200002).time)
        const login = f.login(),
            all = login.find((packet) => packet.id === f.protocol.byName.get('CSProtoAllEquipOrnamentSync').id)
        assert.equal(all.data.ornaments.length, old.length + 2)
        assert.equal(new Set(f.state().ornaments.map((item) => item.guid)).size, old.length + 2)
        assert.deepEqual(f.state().simpleProducts, [])
        const completed = f.state()
        assert.deepEqual(f.game.tick(f.session.id), [])
        assert.deepEqual(f.state(), completed)
    } finally {
        f.close()
    }
})

test('current furniture recommendation shop projects actual701 bundles from18032 and preserves ownership across listing', () => {
    const f = fixture('current-furniture-recommendation-entry')
    try {
        assert(!f.protocol.byName.has('CSProtoHomeFurnitureRecommend'))
        const shop = tables.get('mall_shop').find((row) => row.shopId === 701),
            ids = shop.goodsListPurchase.split('|').map(Number)
        assert.deepEqual(
            [...ids].sort((a, b) => a - b),
            [70101, 70102],
        )
        const initialState = f.state(),
            before = structuredClone({
                bag: f.state().player.sbag_infos,
                heros: f.state().player.heros_info,
                backgrounds: f.state().home.dorm?.back_ground_scene,
            })
        const response = f
            .call('PlayerMallGetPayGoodsList', { pay_shop_id: 701 })
            .find((packet) => packet.id === 18032).data
        assert.deepEqual(
            response.pay_goods_list.map((row) => row.goods_id).sort((a, b) => a - b),
            [70101, 70102],
        )
        const heroGoods = new Map()
        for (const id of ids) {
            const recipe = tables.get('mall_pay_goods').find((row) => row.goodsId === id),
                dorm = parseRewards(recipe.item).find((row) => row.itemtype === 40)
            assert(dorm, 'current dorm bundle has an actual ownership reward')
            const style = tables.find('home_dorm_item', dorm.itemid)
            assert(style?.heroId > 0)
            assert(tables.get('mall_shop_hostel').some((row) => row.goodsId === id && row.heroId === style.heroId))
            const ownedBefore = cosmeticOwnedCount(tables, initialState, 40, dorm.itemid)
            assert.equal(cosmeticOwnedCount(tables, f.state(), 40, dorm.itemid), ownedBefore)
            assert.equal(
                response.pay_goods_list.find((goods) => goods.goods_id === id).is_all_cond_done,
                ownedBefore === 0,
                'current already-owned dorm bundles retain their purchase restriction',
            )
            heroGoods.set(style.heroId, id)
        }
        assert.equal(heroGoods.size, 2, 'current client can build its hero-to-bundle recommendation model')
        assert.deepEqual(
            {
                bag: f.state().player.sbag_infos,
                heros: f.state().player.heros_info,
                backgrounds: f.state().home.dorm?.back_ground_scene,
            },
            before,
        )
    } finally {
        f.close()
    }
})
