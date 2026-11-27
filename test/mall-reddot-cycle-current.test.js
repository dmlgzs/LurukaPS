import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { MallCatalog } from '../src/mall.js'
import { mallReddotUpdate } from '../src/mall-reddots.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    catalog = new MallCatalog(tables)
const monthly = tables
    .get('mall_goods')
    .find((x) => x.redDots === 3 && x.refreshType === 3 && !x.commonCondition && !x.timelimit)
const payWeekly = tables.get('mall_pay_goods').find((x) => x.redDots === 3 && x.refreshType === 5 && !x.commonCondition)
const payMonthly = tables
    .get('mall_pay_goods')
    .find((x) => x.redDots === 3 && x.refreshType === 3 && !x.commonCondition)
const initial = Date.UTC(2026, 10, 27, 9) / 1000
function fixture(file = ':memory:', time = initial) {
    let now = time,
        seq = 1
    const protocol = new Protocol(cfg.base),
        store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now, starterProfile: 'sandbox' }),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'mall-reddot-current' })
    return {
        protocol,
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        raw: () => store.load(session.id),
        setTime: (t) => (now = t),
        close: () => store.close(),
    }
}
function list(f, row, pay) {
    const shop = tables.get('mall_shop').find((x) =>
        String(pay ? x.goodsListPurchase : x.goodsList)
            .split('|')
            .map(Number)
            .includes(row.goodsId),
    )
    assert(shop)
    assert.equal(f.state().player.basic_info.lock_system.includes(shop.systemUnLockId), false)
    const packets = f.call(
        pay ? 'PlayerMallGetPayGoodsList' : 'PlayerMallGetDiamondGoodsList',
        pay ? { pay_shop_id: shop.shopId } : { diamond_shop_id: shop.shopId },
    )
    return packets
        .find((p) => p.id === (pay ? 18032 : 18030))
        .data[pay ? 'pay_goods_list' : 'diamond_goods_list'].find((x) => x.goods_id === row.goodsId)
}
const dot = (packets, field, id) => packets.find((p) => p.id === 18045).data[field].find((x) => x.goods_id === id)
// Current ShopStore0601c975, non-redDots1 branch. A positive cycle deadline
// matters independently of the presence/ownership of a cached goods object.
function effectiveStatus(row, wire, saved, now) {
    if (Number(wire.begin_time) > now) return 0
    if (Number(wire.end_time) && Number(wire.end_time) < now) return 2
    const stock = row.goodsNum <= 0 || wire.curr_purchase_num < row.goodsNum
    if (row.redDots === 1) return stock ? 1 : 2
    if (saved.status === 0) return 1
    if (saved.status === 2 && BigInt(saved.cycle_time ?? 0) > 0n && now > Number(saved.cycle_time)) return 1
    if (saved.status === 1 && !stock) return 2
    return saved.status
}

test('18030/18032→actual shop close18046→18045 reactivates current monthly and weekly goods at their quota calendar', () => {
    const f = fixture()
    try {
        assert(monthly && payWeekly && payMonthly)
        for (const [row, pay] of [
            [monthly, false],
            [payWeekly, true],
            [payMonthly, true],
        ]) {
            f.setTime(initial)
            const field = pay ? 'pay_reddot' : 'diamond_reddot',
                wire = list(f, row, pay),
                end = Number(wire.reset_time)
            const packets = f.call('MallReddotSet', { [field]: [{ goods_id: row.goodsId, status: 2 }] })
            assert.equal(packets[0].id, 18045)
            assert.equal(packets.at(-1).id, 18046)
            const saved = dot(packets, field, row.goodsId)
            assert.equal(saved.cycle_time, String(end))
            assert.equal(effectiveStatus(row, wire, saved, end), 2, 'Native comparison is strictly after deadline')
            const local = new Date((initial + 8 * 3600) * 1000)
            const expected =
                row.refreshType === 3
                    ? Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1, 4) / 1000 - 8 * 3600
                    : Date.UTC(2026, 10, 30, 4) / 1000 - 8 * 3600
            assert.equal(end, expected, 'existing quota reset uses current 4am UTC+8 calendar')
            const unchanged = f.call('MallReddotSet', {
                [field]: [{ goods_id: row.goodsId, status: 2, cycle_time: '9007199254740993' }],
            })
            assert.deepEqual(dot(unchanged, field, row.goodsId), saved, 'client cannot choose a future cycle')
            f.setTime(end + 1)
            const next = list(f, row, pay),
                query = dot(f.call('MallReddotSet'), field, row.goodsId)
            assert(Number(next.reset_time) > end)
            assert.deepEqual(query, saved, 'empty query must not extend dismissed period')
            assert.equal(effectiveStatus(row, next, query, end + 1), 1)
            const closedAgain = dot(
                f.call('MallReddotSet', { [field]: [{ goods_id: row.goodsId, status: 2 }] }),
                field,
                row.goodsId,
            )
            assert.equal(closedAgain.cycle_time, next.reset_time)
            assert.equal(effectiveStatus(row, next, closedAgain, end + 1), 2)
        }
    } finally {
        f.close()
    }
})

test('nonperiodic/automatic/no-red-dot/BeginTime local hold rows do not manufacture deadlines; daily rules share the existing calendar', () => {
    const picks = [
        [
            catalog.diamond,
            [...catalog.diamond.values()].find((x) => x.redDots === 3 && x.refreshType === 1),
            'diamond_reddot',
        ],
        [
            catalog.diamond,
            [...catalog.diamond.values()].find((x) => x.redDots === 0 && x.refreshType === 3),
            'diamond_reddot',
        ],
        [catalog.diamond, [...catalog.diamond.values()].find((x) => x.redDots === 1), 'diamond_reddot'],
        [catalog.pay, [...catalog.pay.values()].find((x) => x.refreshType === 6), 'pay_reddot'],
    ]
    for (const [, row, field] of picks) {
        assert(row)
        const result = mallReddotUpdate(
            catalog,
            undefined,
            { [field]: [{ goods_id: row.goodsId, status: 2 }] },
            initial,
        )
        assert.equal(result[field][0].cycle_time, '0')
    }
    // No current redDots2/3 row uses daily refresh; this table-derived daily row
    // is a pure calendar branch vector, not a claim of a currently emitted dot.
    const daily = [...catalog.diamond.values()].find((x) => x.refreshType === 4)
    assert(daily)
    const row = { ...daily, redDots: 3 },
        isolated = { diamond: new Map([[row.goodsId, row]]), pay: new Map(), window: (r) => catalog.window(r, initial) }
    const result = mallReddotUpdate(
        isolated,
        undefined,
        { diamond_reddot: [{ goods_id: row.goodsId, status: 2 }] },
        initial,
    )
    assert.equal(result.diamond_reddot[0].cycle_time, String(catalog.window(row, initial).end))
})

test('stable empty query and same-period dismissal preserve state/revision/request log/SQL writes; pure queries do not initialize a mailbox-like ledger', () => {
    const blank = {},
        before = structuredClone(blank)
    assert.deepEqual(mallReddotUpdate(catalog, undefined, blank, initial), { diamond_reddot: [], pay_reddot: [] })
    assert.deepEqual(blank, before)
    const f = fixture()
    try {
        f.call('MallReddotSet', { diamond_reddot: [{ goods_id: monthly.goodsId, status: 2 }] })
        // Settle all ordinary observer catchup before measuring steady queries.
        f.call('MallReddotSet')
        const raw = f.raw(),
            changes = f.store.db.prepare('SELECT total_changes() AS n').get().n,
            logs = f.store.db.prepare('SELECT count(*) AS n FROM request_log').get().n
        for (let i = 0; i < 3; i++) f.call('MallReddotSet')
        f.call('MallReddotSet', { diamond_reddot: [{ goods_id: monthly.goodsId, status: 2 }] })
        assert.deepEqual(f.raw(), raw)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM request_log').get().n, logs)
    } finally {
        f.close()
    }
})

test('mixed bad goods, failed18045 encoding and SQLite commit reject the entire red-dot update; successful retry survives cold reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-reddot-current-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture(file),
        original = f.protocol.encode.bind(f.protocol)
    try {
        const before = f.raw()
        assert.throws(() =>
            f.call('MallReddotSet', {
                diamond_reddot: [{ goods_id: monthly.goodsId, status: 2 }],
                pay_reddot: [{ goods_id: 4294967295, status: 2 }],
            }),
        )
        assert.deepEqual(f.raw(), before)
        f.protocol.encode = (name, data) => {
            if (name === f.protocol.byId.get(18045).rsp) throw Error('reddot codec')
            return original(name, data)
        }
        assert.throws(
            () => f.call('MallReddotSet', { diamond_reddot: [{ goods_id: monthly.goodsId, status: 2 }] }),
            /reddot codec/,
        )
        f.protocol.encode = original
        assert.deepEqual(f.raw(), before)
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_reddot BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'reddot SQL'); END",
        )
        assert.throws(
            () => f.call('MallReddotSet', { diamond_reddot: [{ goods_id: monthly.goodsId, status: 2 }] }),
            /reddot SQL/,
        )
        f.store.db.exec('DROP TRIGGER reject_reddot')
        assert.deepEqual(f.raw(), before)
        const marked = dot(
            f.call('MallReddotSet', { diamond_reddot: [{ goods_id: monthly.goodsId, status: 2 }] }),
            'diamond_reddot',
            monthly.goodsId,
        )
        const dots = structuredClone(f.state().mall.reddots)
        f.close()
        f = fixture(file, Number(marked.cycle_time) + 1)
        assert.deepEqual(f.state().mall.reddots, dots)
        const wire = list(f, monthly, false),
            saved = dot(f.call('MallReddotSet'), 'diamond_reddot', monthly.goodsId)
        assert.equal(effectiveStatus(monthly, wire, saved, Number(marked.cycle_time) + 1), 1)
    } finally {
        f.close()
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('a legacy dismissal without date stays lossless and unknown until an actual new status update establishes its period', () => {
    const previous = { diamond_reddot: [{ goods_id: monthly.goodsId, status: 2 }], pay_reddot: [] },
        before = structuredClone(previous)
    assert.deepEqual(mallReddotUpdate(catalog, previous, {}, initial), previous)
    assert.deepEqual(previous, before)
    const next = mallReddotUpdate(
        catalog,
        previous,
        { diamond_reddot: [{ goods_id: monthly.goodsId, status: 2 }] },
        initial,
    )
    assert.equal(next.diamond_reddot[0].cycle_time, String(catalog.window(monthly, initial).end))
    assert.deepEqual(previous, before)
})
