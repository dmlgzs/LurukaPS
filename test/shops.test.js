import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { refreshWindow, configTime } from '../src/shops.js'
const c = configuration(),
    p = new Protocol(c.base),
    t = new Tables(c.tables)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(p, store, t),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'shop' })
    store.transact(session.id, 0, (s) => {
        s.player.attr_infos.attrs = [
            ...s.player.attr_infos.attrs.filter((row) => row.attr_id !== 413),
            { attr_id: 413, attr_val: '1000' },
        ]
    })
    return { store, session, call }
}
const basket = (times, goods = 502001) => ({ shop_id: 502, items: [{ slot_id: goods, goods_id: goods, times }] })
test('shop list, purchase prices, delivered goods and persistent limit count', () => {
    const { store, session, call } = setup()
    try {
        const packets = call('ShopInfoReq', { shop_id: 502 })
        const info = p.decode('SCShopInfoSync', packets.find((x) => x.id === 6072).payload).shop_info
        assert.equal(info.shop_items[0].shop_store_num, 20)
        assert.equal(info.shop_items[0].buy_times, 0)
        assert(info.shop_items[0].dead_time > Date.now() / 1000)
        call('ShopBuyItems', basket(2))
        const s = store.load(session.id).state
        assert.equal(s.player.attr_infos.attrs.find((row) => row.attr_id === 413).attr_val, '968')
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 400002).itemnum, 2)
        assert.equal(s.shopPurchases['502:502001'].count, 2)
        const listed = call('ListShopArrayItems', { shop_ids: [502, 502] })
        const data = p.decode('SCListShopItemsArray', listed.find((packet) => packet.id === 6073).payload)
        assert.equal(data.infos.length, 1)
        assert.equal(data.infos[0].shop_items[0].buy_times, 2)
    } finally {
        store.close()
    }
})
test('batched duplicates, wrong membership and insufficient currency roll back', () => {
    const { store, session, call } = setup()
    try {
        const before = store.load(session.id)
        for (const request of [
            {
                shop_id: 502,
                items: [
                    { slot_id: 502001, goods_id: 502001, times: 12 },
                    { slot_id: 502001, goods_id: 502001, times: 9 },
                ],
            },
            basket(1, 504001),
            { shop_id: 502, items: [{ slot_id: 502001, goods_id: 502002, times: 1 }] },
            basket(1, 502002),
        ]) {
            assert.throws(() => call('ShopBuyItems', request))
            assert.deepEqual(store.load(session.id), before)
        }
        store.transact(session.id, 0, (s) => {
            s.player.attr_infos.attrs.find((row) => row.attr_id === 413).attr_val = '15'
        })
        const poor = store.load(session.id)
        assert.throws(() => call('ShopBuyItems', basket(1)), /Insufficient/)
        assert.deepEqual(store.load(session.id), poor)
    } finally {
        store.close()
    }
})
test('free configured goods still consume permanent stock quota', () => {
    const { store, session, call } = setup()
    try {
        const r = { shop_id: 200001, items: [{ slot_id: 2010101, goods_id: 2010101, times: 4 }] }
        call('ShopBuyItems', r)
        const s = store.load(session.id).state
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 310001).itemnum, 4)
        assert.equal(s.shopPurchases['200001:2010101'].count, 4)
        const before = store.load(session.id)
        assert.throws(() => call('ShopBuyItems', { ...r, items: [{ ...r.items[0], times: 1 }] }), /limit/)
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})
test('refresh windows use calendar boundaries at UTC+8 configured reset time', () => {
    const before = Date.parse('2026-10-01T03:59:59+08:00') / 1000,
        after = before + 1
    assert.equal(refreshWindow({ refreshType: 3, refreshTypeParam: '1' }, before).end, after)
    assert.equal(refreshWindow({ refreshType: 3, refreshTypeParam: '1' }, after).start, after)
    const monday = Date.parse('2026-09-28T04:00:00+08:00') / 1000
    assert.equal(refreshWindow({ refreshType: 5, refreshTypeParam: '1' }, monday - 1).end, monday)
    assert.equal(refreshWindow({ refreshType: 4, refreshTypeParam: '40000' }, monday).end, monday + 86400)
    assert.deepEqual(refreshWindow({ refreshType: 1 }, after), { start: 0, end: 0 })
    assert.equal(configTime('20220311-100000'), Date.parse('2022-03-11T10:00:00+08:00') / 1000)
    assert.throws(() => configTime('20220230-100000'))
})
test('a later full egg bag rolls back earlier grants, payments and purchase counts', () => {
    const { store, session, call } = setup()
    try {
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 25
            s.petEggs = Array.from({ length: 1000 }, (_, i) => ({
                guid: i + 1,
                configid: 40003007,
                hatch_state: 1,
                egg_affix: [],
            }))
        })
        const before = store.load(session.id)
        assert.throws(
            () =>
                call('ShopBuyItems', {
                    shop_id: 502,
                    items: [
                        { slot_id: 502001, goods_id: 502001, times: 1 },
                        { slot_id: 502002, goods_id: 502002, times: 1 },
                    ],
                }),
            /egg bag is full/,
        )
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})
test('an expired purchase period restores stock without carrying old quota into the new period', () => {
    const { store, session, call } = setup()
    try {
        store.transact(session.id, 0, (s) => {
            s.shopPurchases = { '502:502001': { period: 0, count: 20 } }
        })
        const info = p.decode(
            'SCShopInfoSync',
            call('ShopInfoReq', { shop_id: 502 }).find((x) => x.id === 6072).payload,
        )
        assert.equal(info.shop_info.shop_items[0].buy_times, 0)
        call('ShopBuyItems', basket(1))
        const receipt = store.load(session.id).state.shopPurchases['502:502001']
        assert.equal(receipt.count, 1)
        assert(receipt.period > 0)
    } finally {
        store.close()
    }
})
