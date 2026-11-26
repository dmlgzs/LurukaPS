import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { ShopCatalog, configTime } from '../src/shops.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { staticTimeRows } from '../src/time-definitions.js'
import { tableExportManifest } from '../src/table-source.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
test('current dated stage shops close after their exported end; public purchases then fail atomically', () => {
    const ids = [100101, 100102, 100103],
        source = ids.map((id) => tables.get('shop').find((row) => row.shopId === id)),
        calendar = new ShopCatalog(tables),
        state = seedPlayer(tables, 1, 'current-shop-window'),
        observed = 1791824493
    assert(source.every((row) => row && row.startTime && row.endTime))
    // The historical October request is no longer after all current periods:
    // current stages1/2 run through Jan2027 and stage3 starts in Dec2026.
    assert.deepEqual(
        ids.map((id) => calendar.shop(id, state, observed).open),
        [true, true, false],
    )
    const endByShop = new Map(source.map((row) => [row.shopId, configTime(row.endTime)])),
        cutoff = Math.max(...endByShop.values()) + 1
    const p = new Protocol(cfg.base),
        s = new Store(':memory:'),
        g = new Game(p, s, tables, { clock: () => cutoff }),
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
        assert.ok(
            reply.infos.every(
                (x) => x.shop_items.length === 0 && x.end_time === endByShop.get(x.shop_id) && x.end_time < cutoff,
            ),
        )
        const before = s.load(session.id)
        assert.throws(
            () => call('ShopBuyItems', { shop_id: 100101, items: [{ slot_id: 1001501, goods_id: 1001501, times: 1 }] }),
            (error) => error.code === ErrorCode.ShopNotOpen,
        )
        assert.deepEqual(s.load(session.id), before)
    } finally {
        s.close()
    }
})
test('current complete export without a static calendar uses explicit dates and preserves exact boundaries and strict missing-source failures', () => {
    const catalog = new ShopCatalog(tables),
        state = seedPlayer(tables, 1, 'shop-window'),
        source = catalog.shops.get(100102)
    const manifest = tableExportManifest(tables)
    assert(manifest, 'only complete source evidence permits a missing static-calendar interpretation')
    assert.equal(manifest.names.has('common_timelimit'), false)
    assert.equal(staticTimeRows(tables), undefined)
    const start = configTime(source.startTime),
        end = configTime(source.endTime)
    assert(source.timelimit > 0 && start > 0 && end > start)
    assert.deepEqual(catalog.schedule(source), { start, end })
    for (const [now, expected] of [
        [start - 1, false],
        [start, true],
        [end - 1, true],
        [end, false],
    ])
        assert.equal(catalog.shop(source.shopId, state, now).open, expected)
    assert.throws(() => catalog.schedule({ timelimit: 999999, launchType: 1 }), { code: ErrorCode.GameConfig })
    // These isolated negative source views are not restored/overlaid old tables.
    // Unclassified absence or a corrupt optional provider must stay strict even
    // when the calling row also carries otherwise valid explicit dates.
    const unavailable = {
        get(name) {
            if (name === 'common_timelimit') throw Error('unclassified-calendar-missing')
            return tables.get(name)
        },
    }
    assert.throws(() => new ShopCatalog(unavailable).schedule(source), /unclassified-calendar-missing/)
    const corrupt = {
        get(name) {
            return name === 'common_timelimit' ? { invalid: true } : tables.get(name)
        },
    }
    assert.throws(() => new ShopCatalog(corrupt).schedule(source), { code: ErrorCode.GameConfig })
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
            assert.equal(
                p.decode('SCListShopItemsArray', packets.find((packet) => packet.id === 6073).payload).infos[0]
                    .shop_items.length,
                1,
            )
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
