import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { ShopCatalog, configTime } from '../src/shops.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
test('logged expired stage shops query as closed without entering invalid goods dates; purchases fail atomically', () => {
    const p = new Protocol(cfg.base),
        s = new Store(':memory:'),
        g = new Game(p, s, tables, { clock: () => 1791824493 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return g.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'expired-event-shop' })
        const packets = call('ListShopArrayItems', { shop_ids: [100101, 100102, 100103] })
        const e = p.byName.get('CSProtoListShopArrayItems')
        const reply = p.decode(e.rsp, packets.find((packet) => packet.id === e.id).payload)
        assert.equal(reply.infos.length, 3)
        assert.ok(reply.infos.every((x) => x.shop_items.length === 0 && x.end_time < 1791824493))
        const before = structuredClone(s.load(session.id).state.player)
        assert.throws(
            () => call('ShopBuyItems', { shop_id: 100101, items: [{ slot_id: 1001501, goods_id: 1001501, times: 1 }] }),
            (error) => error.code === ErrorCode.ShopNotOpen,
        )
        assert.deepEqual(s.load(session.id).state.player, before)
    } finally {
        s.close()
    }
})
test('event launchType1 resolves common time limit then explicit dates, and boundaries preserve closed query semantics', () => {
    const catalog = new ShopCatalog(tables),
        state = seedPlayer(tables, 1, 'shop-window'),
        source = catalog.shops.get(100102)
    catalog.shops.set(source.shopId, {
        ...source,
        goodsList: '',
        startTime: '20261013-100000',
        endTime: '20261014-100000',
    })
    assert.equal(catalog.shop(source.shopId, state, configTime('20261013-100000')).open, true)
    assert.equal(catalog.shop(source.shopId, state, configTime('20261014-100000')).open, false)
    const limit = tables.get('common_timelimit')[0]
    assert.deepEqual(catalog.schedule({ timelimit: limit.id, launchType: 1 }), {
        start: configTime(limit.startTime),
        end: configTime(limit.endTime),
    })
    assert.throws(() => catalog.schedule({ timelimit: 999999, launchType: 1 }), /schedule configuration unavailable/)
})

test('shop schedule distinguishes invalid fields from unsupported launch modes and absent shop records', () => {
    const catalog = new ShopCatalog(tables)
    const fails = (fn, code) => assert.throws(fn, (error) => error.code === code)
    fails(() => catalog.schedule({ launchType: -1 }), ErrorCode.GameConfig)
    fails(() => catalog.schedule({ launchType: 2 }), ErrorCode.InvalidLogic)
    fails(() => catalog.schedule({ timelimit: 'bad' }), ErrorCode.GameConfig)
    fails(() => catalog.schedule({ timelimit: 999999, launchType: 1 }), ErrorCode.GameConfig)
    fails(() => catalog.schedule({ startTime: '20261021-100000', endTime: '20261020-100000' }), ErrorCode.GameConfig)
    fails(() => catalog.schedule({ startTime: '20261021-100065' }), ErrorCode.GameConfig)
    fails(() => catalog.info(0xffffffff, {}, 1791824493), ErrorCode.ShopConfNotExist)
})

for (const [mode, code] of [
    ['open', null],
    ['future', ErrorCode.ShopItemNotInTime],
    ['locked', ErrorCode.ShopItemUnlock],
]) {
    test(`scheduled shop purchase ${mode} uses its time/unlock rule without losing currency or stock on rejection`, () => {
        const local = new Tables(cfg.tables)
        const dates = { launchType: 1, timelimit: 0, startTime: '20261021-100000', endTime: '20261022-100000' }
        local.cache.set(
            'shop',
            local.get('shop').map((row) => (row.shopId === 502 ? { ...row, ...dates, goodsList: '502001' } : row)),
        )
        local.cache.set(
            'goods',
            local.get('goods').map((row) =>
                row.goodsId === 502001
                    ? {
                          ...row,
                          ...dates,
                          startTime: mode === 'future' ? '20261022-090000' : dates.startTime,
                          commonCondition: mode === 'locked' ? '2004#99' : '',
                      }
                    : row,
            ),
        )
        const p = new Protocol(cfg.base),
            s = new Store(':memory:'),
            session = {}
        const game = new Game(p, s, local, { clock: () => configTime('20261021-120000') })
        let sequence = 1
        const call = (name, request = {}) => {
            const entry = p.byName.get('CSProto' + name)
            return game.dispatch(session, { id: entry.id, seq: sequence++, payload: p.encode(entry.req, request) })
        }
        try {
            call('EnterGame', { open_id: 'scheduled-shop-' + mode })
            s.transact(session.id, 0, (state) => {
                state.player.attr_infos.attrs = [
                    ...state.player.attr_infos.attrs.filter((row) => row.attr_id !== 413),
                    { attr_id: 413, attr_val: '1000' },
                ]
            })
            const packets = call('ListShopArrayItems', { shop_ids: [502] })
            assert.equal(p.decode('SCListShopItemsArray', packets.find((packet) => packet.id === 6073).payload).infos[0].shop_items.length, 1)
            const request = { shop_id: 502, items: [{ slot_id: 502001, goods_id: 502001, times: 1 }] }
            if (code) {
                const before = structuredClone(s.load(session.id).state)
                assert.throws(
                    () => call('ShopBuyItems', request),
                    (error) => error.code === code,
                )
                assert.deepEqual(s.load(session.id).state.player, before.player)
                assert.deepEqual(s.load(session.id).state.shopPurchases, before.shopPurchases)
            } else {
                call('ShopBuyItems', request)
                const state = s.load(session.id).state
                assert.equal(state.player.attr_infos.attrs.find((row) => row.attr_id === 413).attr_val, '984')
                assert.equal(state.player.sbag_infos.items.find((row) => row.itemid === 400002).itemnum, 1)
                assert.equal(state.shopPurchases['502:502001'].count, 1)
            }
        } finally {
            s.close()
        }
    })
}
