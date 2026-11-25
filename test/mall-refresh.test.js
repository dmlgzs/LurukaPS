import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { MallCatalog } from '../src/mall.js'
import { ShopCatalog, refreshWindow, configTime } from '../src/shops.js'
import { mallBeginTimeRefreshWindow } from '../src/mall-time-policy.js'
import { payGoodsPlan } from '../src/mall-pay-goods.js'
import policy from '../configs/mall-schedule-policy.json' with { type: 'json' }
import { ErrorCode } from '../src/error-codes.js'

const tables = new Tables(configuration().tables)
const hour = Number(tables.get('game').find((row) => row.title === 'DAILY_REFRESH_TIME').value)
const now = configTime('20261126-120000')
const pay = tables.get('mall_pay_goods')
const begins = pay.filter((row) => row.refreshType === 6)

test('monthly refresh crosses the configured first-day reset hour and year boundary exactly', () => {
    const row = { refreshType: 3, refreshTypeParam: '1' }
    assert.deepEqual(refreshWindow(row, configTime('20270101-035959'), hour), {
        start: configTime('20261201-040000'),
        end: configTime('20270101-040000'),
    })
    assert.deepEqual(refreshWindow(row, configTime('20270101-040000'), hour), {
        start: configTime('20270101-040000'),
        end: configTime('20270201-040000'),
    })
})

test('weekly refresh parameter 1 means Monday and changes period exactly at the game reset hour', () => {
    const row = { refreshType: 5, refreshTypeParam: '1' }
    assert.deepEqual(refreshWindow(row, configTime('20261123-035959'), hour), {
        start: configTime('20261116-040000'),
        end: configTime('20261123-040000'),
    })
    assert.deepEqual(refreshWindow(row, configTime('20261123-040000'), hour), {
        start: configTime('20261123-040000'),
        end: configTime('20261130-040000'),
    })
})

test('mall daily list-form parameters and ordinary-shop HHMMSS share the exact reset instant', () => {
    const catalog = new MallCatalog(tables)
    const before = configTime('20261126-035959')
    assert.deepEqual(catalog.window({ refreshType: 4, refreshTypeParam: '4|0|0' }, before), {
        start: configTime('20261125-040000'),
        end: configTime('20261126-040000'),
    })
    assert.deepEqual(
        catalog.window({ refreshType: 4, refreshTypeParam: '4|0|0' }, before + 1),
        refreshWindow({ refreshType: 4, refreshTypeParam: '040000' }, before + 1, hour),
    )
})

test('all current diamond and pay mall rows construct read-only lists without unsupported refresh modes', () => {
    const catalog = new MallCatalog(tables)
    const state = seedPlayer(tables, 1, 'mall-refresh-read-only')
    const before = structuredClone(state)
    assert.equal(catalog.list(false, 0, 0, state, now).length, tables.get('mall_goods').length)
    assert.equal(catalog.list(true, 0, 0, state, now).length, pay.length)
    assert.deepEqual(state, before)
})

test('every current ordinary goods row has a supported refresh mode including weekly rows', () => {
    const goods = tables.get('goods')
    assert.ok(goods.some((row) => row.refreshType === 5))
    for (const row of goods) {
        const window = refreshWindow(row, now, hour)
        assert.ok(Number.isSafeInteger(window.start) && Number.isSafeInteger(window.end))
        assert.ok(window.end === 0 || (window.start <= now && now < window.end))
    }
})

test('BeginTime [21] never becomes an invented 21-day rolling quota reset', () => {
    assert.equal(begins.length, 8)
    const catalog = new MallCatalog(tables)
    for (const row of begins) {
        assert.equal(row.refreshTypeParam, '21')
        assert.deepEqual(catalog.window(row, now), { start: 0, end: 0 })
        assert.deepEqual(catalog.window(row, now + 22 * 86400), { start: 0, end: 0 })
    }
})

test('BeginTime retains saved quota counts across a legacy period key and cannot reissue a limited pack', () => {
    const catalog = new MallCatalog(tables)
    const row = begins[0]
    const state = seedPlayer(tables, 1, 'mall-refresh-legacy-begin')
    state.mall = { purchases: { [`pay:${row.goodsId}`]: { period: now - 86400, count: row.goodsNum } } }
    const before = structuredClone(state)
    const shop = [...catalog.shops.values()].find((entry) =>
        String(entry.goodsListPurchase).split('|').map(Number).includes(row.goodsId),
    )
    assert.ok(shop)
    for (const at of [now, now + 22 * 86400]) {
        const wire = catalog.goods(true, row.goodsId, state, at)
        assert.equal(wire.curr_purchase_num, row.goodsNum)
        assert.equal(wire.reset_time, '0')
        assert.throws(
            () =>
                payGoodsPlan(
                    { tables, state, now: at },
                    { pay_shop_id: shop.shopId, pay_goods_id: row.goodsId, buy_count: 1 },
                    catalog,
                ),
            (error) => error.code === ErrorCode.MallGoodsNumLimit,
        )
    }
    assert.deepEqual(state, before)
})

test('NoRefresh mall and ordinary goods preserve the saved count lower bound from old daily periods', () => {
    const catalog = new MallCatalog(tables)
    const row = pay.find((entry) => entry.refreshType === 1)
    const state = seedPlayer(tables, 1, 'mall-refresh-legacy-permanent')
    state.mall = { purchases: { [`pay:${row.goodsId}`]: { period: now - 86400, count: 3 } } }
    assert.equal(catalog.goods(true, row.goodsId, state, now).curr_purchase_num, 3)
    const shops = new ShopCatalog(tables)
    const entry = [...shops.shops.values()]
        .flatMap((shop) =>
            String(shop.goodsList)
                .split('|')
                .map(Number)
                .map((slotId) => ({ shop, slotId, goods: shops.goods.get(shops.slots.get(slotId)?.slotParam) })),
        )
        .find(({ goods }) => goods?.refreshType === 1 && !goods.specialPrice && !goods.recommend)
    assert.ok(entry)
    state.shopPurchases = { [`${entry.shop.shopId}:${entry.slotId}`]: { period: now - 86400, count: 3 } }
    assert.equal(shops.item(entry.shop, entry.slotId, state, now).bought, 3)
})

test('the conservative BeginTime strategy is configurable and never applies to unknown goods', () => {
    const row = begins[0]
    assert.throws(
        () =>
            mallBeginTimeRefreshWindow(tables, row, {
                ...policy,
                beginTimeRefresh: { ...policy.beginTimeRefresh, enabled: false },
            }),
        (error) => error.code === ErrorCode.MallConfigError,
    )
    assert.throws(
        () => mallBeginTimeRefreshWindow(tables, { ...row, goodsId: 0xffffffff }),
        (error) => error.code === ErrorCode.MallConfigError,
    )
})
