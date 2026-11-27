import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { GrowupSystem } from '../src/growup.js'
import { growupEndingTrial, growupEndingMatchesTrial } from '../src/growup-ending.js'
import { commitPermanentEnding, preparePermanent, permanentModel } from '../src/growup-permanent.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)

import { ShopCatalog } from '../src/shops.js'
import { completedGrowupEndingCount } from '../src/shop-conditions.js'
import { grantRewards } from '../src/rewards.js'
const NOW = Date.parse('2026-11-27T09:00:00+08:00') / 1000
function fixture(account, file) {
    const protocol = new Protocol(cfg.base),
        store = new Store(file),
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => NOW, rng: () => 0 })
    let seq = 1
    const call = (name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, value) })
    }
    call('EnterGame', { open_id: account })
    store.transact(session.id, 0, (state) => {
        // Trusted qualification baseline, not a claim that this fixture played the guide or training cycle.
        state.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
        state.tasks = []
    })
    const state = () => store.load(session.id).state
    const system = game.activities.growup,
        catalog = game.activities
    const row = catalog.rows.find((value) => value.id === 60001)
    const start = () =>
        call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
    const reset = () => {
        call('ActivityGrowUpResetReq', { activity_id: 60001 })
        start()
    }
    const training = (finalId) =>
        store.transact(session.id, 0, (s) => {
            const g = s.activities[60001].growup
            g.growup_train_attr.forEach((attr) => {
                attr.attr_value = 1000
            })
            Object.assign(g, {
                cur_stage: 3,
                cur_growup_stage: 13,
                cur_growup_trail_stage: 3,
                select_trail_id: finalId,
            })
            g.trails = [101, 201, finalId].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: g.guid }))
            s.acceptedCultTrials ??= {}
            for (const result of g.trails) s.acceptedCultTrials[`${g.guid}:${result.trail_id}`] = true
        })
    const complete = (finalId, options = {}) =>
        store.transact(session.id, 0, (s) => {
            const entry = s.activities[60001],
                g = entry.growup
            const trial = tables
                .get('game_events_cul_trial')
                .find((value) => value.systemId === 60001 && value.trialId === finalId)
            const snapshot = system.finish(g, 60001, trial)
            options.capture?.(snapshot)
            const proof = system.endingCompletionProof(snapshot, g)
            assert(proof)
            assert.equal(system.endingCompletionProof(structuredClone(snapshot), g), undefined)
            assert.equal(system.endingCompletionProof(snapshot, structuredClone(g)), undefined)
            const value = snapshot.top_rating
            snapshot.top_rating = '0'
            assert.equal(system.endingCompletionProof(snapshot, g), undefined)
            snapshot.top_rating = value
            const context = {
                id: session.id,
                state: s,
                now: NOW,
                pushBefore(name, data) {
                    const type = protocol.byName.get(name).rsp
                    if (options.failPublication) throw Error('ending publication codec failure')
                    protocol.encode(type, data)
                },
            }
            for (const unproven of [structuredClone(snapshot), { ...structuredClone(snapshot), completed: true }])
                assert.throws(
                    () => commitPermanentEnding(context, catalog, row, entry, unproven, 'trial-completion'),
                    (error) => error.code === ErrorCode.GameConfig,
                )
            snapshot.top_rating = '0'
            assert.throws(
                () => commitPermanentEnding(context, catalog, row, entry, snapshot, 'trial-completion'),
                (error) => error.code === ErrorCode.GameConfig,
            )
            snapshot.top_rating = value
            if (options.stale) {
                assert.equal(system.endingCompletionProof(options.stale, g), undefined)
                assert.throws(
                    () => commitPermanentEnding(context, catalog, row, entry, options.stale, 'trial-completion'),
                    (error) => error.code === ErrorCode.GameConfig,
                )
            }
            commitPermanentEnding(context, catalog, row, entry, snapshot, 'trial-completion')
            return { snapshot, proof }
        })
    start()
    return {
        game,
        protocol,
        store,
        session,
        system,
        catalog,
        row,
        state,
        call,
        start,
        reset,
        training,
        complete,
        hash: () =>
            createHash('sha256')
                .update(JSON.stringify(store.load(session.id)))
                .digest('hex'),
    }
}

const rows = tables.get('goods').filter((row) => row.commonCondition.startsWith('80003#'))
const slotFor = (row) => tables.get('shop_slot').find((slot) => slot.slotType === 1 && slot.slotParam === row.goodsId)
const shopFor = (row) =>
    tables.get('shop').find((shop) => shop.goodsList.split('|').map(Number).includes(slotFor(row).slotId))
const req = (row) => ({
    shop_id: shopFor(row).shopId,
    items: [{ slot_id: slotFor(row).slotId, goods_id: row.goodsId, times: 1 }],
})
const item = (f, row) => {
    const packets = f.call('ShopInfoReq', { shop_id: shopFor(row).shopId })
    return f.protocol
        .decode(f.protocol.byId.get(6072).rsp, packets.find((x) => x.id === 6072).payload)
        .shop_info.shop_items.find((x) => x.goods_id === row.goodsId)
}
const funds = (s) => BigInt(s.player.attr_infos.attrs.find((x) => x.attr_id === 10011)?.attr_val ?? 0)
const fixedCurrency = (f, n = 5000) =>
    f.store.transact(f.session.id, 0, (s) => grantRewards(tables, s, [{ itemtype: 10, itemid: 10011, itemnum: n }]))
function history(f) {
    return f.game.activities.growupHistorySnapshots(f.state(), NOW).find((x) => x.activity_id === 60001)
}
function nativeBookCount(wire) {
    const map = new Map(wire.end_data.map((x) => [x.id, x]))
    return [...map.values()].filter((x) => x.state === 1).length
}

test('current80003 shop rows use the actual successful ending book: thresholds1/2/4, duplicate ending and public purchases', () => {
    assert.equal(rows.length, 3)
    const f = fixture('shop-ending-count-current', ':memory:')
    try {
        fixedCurrency(f)
        const ordered = [...rows].sort(
            (a, b) => Number(a.commonCondition.split('#')[2]) - Number(b.commonCondition.split('#')[2]),
        )
        const catalog = new ShopCatalog(tables)
        for (const row of ordered) {
            assert.equal(catalog.item(shopFor(row), slotFor(row).slotId, f.state(), NOW).unlocked, false)
            assert.deepEqual(item(f, row).unlock_progress, [0])
        }
        f.training(301)
        f.complete(301)
        assert.equal(nativeBookCount(history(f)), 1)
        assert.equal(completedGrowupEndingCount(f.state(), 60001), 1)
        const one = ordered[0],
            two = ordered[1],
            four = ordered[2]
        assert.deepEqual(item(f, one).unlock_progress, [1])
        assert.equal(catalog.item(shopFor(one), slotFor(one).slotId, f.state(), NOW).unlocked, true)
        let before = f.store.load(f.session.id)
        for (const row of [two, four]) {
            assert.throws(
                () => f.call('ShopBuyItems', req(row)),
                (e) => e.code === ErrorCode.ShopItemUnlock,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        const firstPackets = f.call('ShopBuyItems', req(one)),
            first = f.protocol.decode(f.protocol.byId.get(6071).rsp, firstPackets.find((x) => x.id === 6071).payload)
        assert(first.rewards.flatMap((x) => x.rewards).length)
        assert.equal(funds(f.state()), 4200n)
        assert.equal(f.state().shopPurchases[`${shopFor(one).shopId}:${slotFor(one).slotId}`].count, 1)
        f.reset()
        f.training(301)
        f.complete(301)
        assert.equal(
            nativeBookCount(history(f)),
            1,
            'a second genuine run with the same ending is still one book entry',
        )
        assert.equal(completedGrowupEndingCount(f.state(), 60001), 1)
        f.reset()
        f.training(302)
        f.complete(302)
        assert.equal(completedGrowupEndingCount(f.state(), 60001), 2)
        assert.deepEqual(item(f, two).unlock_progress, [2])
        f.call('ShopBuyItems', req(two))
        assert.equal(funds(f.state()), 3800n)
        f.reset()
        f.training(303)
        f.complete(303)
        before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('ShopBuyItems', req(four)),
            (e) => e.code === ErrorCode.ShopItemUnlock,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.reset()
        f.training(304)
        f.complete(304)
        assert.equal(nativeBookCount(history(f)), 4)
        assert.deepEqual(item(f, four).unlock_progress, [4])
        f.call('ShopBuyItems', req(four))
        assert.equal(funds(f.state()), 3400n)
        assert.deepEqual(
            f.state().activities[60001].growup.end_data.complete_end.map((x) => x.id),
            [101, 102, 103, 104],
        )
        before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('ShopBuyItems', req(one)),
            (e) => e.code === ErrorCode.ShopGoodsConfLimit,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('scenario namespaces, unique IDs and current AND groups do not borrow run counts, assistants, claims or an OR bypass', () => {
    const state = {
        player: { basic_info: { lv: 1 } },
        taskRecords: [],
        activities: { 60002: { growup: { end_data: { complete_end: [{ id: 201 }, { id: 201 }, { id: 202 }] } } } },
        growupPermanent: { endings: { unrelated: { ending_id: 101 } } },
    }
    assert.equal(completedGrowupEndingCount(state, 60001), 0)
    assert.equal(completedGrowupEndingCount(state, 60002), 2)
    const config = structuredClone(rows[0]),
        slot = slotFor(config),
        shop = shopFor(config),
        catalog = new ShopCatalog(tables)
    catalog.goods.set(config.goodsId, config)
    const check = (rule) => {
        config.commonCondition = rule
        return catalog.item(shop, slot.slotId, state, NOW)
    }
    assert.equal(check('80003#60001#1').unlocked, false)
    state.activities[60001] = { growup: { end_data: { complete_end: [{ id: 101 }, { id: 101 }] } } }
    assert.equal(check('80003#60001#1').unlocked, true)
    assert.equal(
        check('2004#2|80003#60001#1').unlocked,
        false,
        'pipe condition group is AND, even when one clause passes',
    )
    state.player.basic_info.lv = 2
    assert.equal(check('2004#2|80003#60001#1').unlocked, true)
    assert.equal(check('2007#106001|80003#60001#1').unlocked, false)
    state.taskRecords.push({ task_id: 106001, count: 1 })
    assert.equal(check('2007#106001|80003#60001#1').unlocked, true)
    for (const bad of [
        '80003#60001',
        '80003#60001#1#2',
        '80003#60001#0',
        '80003#60001#-1',
        '999999#1',
        '2004#1#999',
        '2004#2||80003#60001#1',
        '2004#2&80003#60001#1',
    ])
        assert.equal(check(bad).unlocked, false, bad)
    state.activities[60001].growup.end_data.complete_end = [{ id: NaN }]
    assert.throws(
        () => check('80003#60001#1'),
        (e) => e.code === ErrorCode.GameConfig,
    )
    state.activities[60001].growup.end_data.complete_end = null
    assert.throws(
        () => check('80003#60001#1'),
        (e) => e.code === ErrorCode.GameConfig,
    )
    // Native's incoming book counts only State1. This is a consumer vector,
    // not a new server failed-run grant policy: only committed complete_end
    // is currently published as State1 by the server's existing endQuery.
    assert.equal(
        nativeBookCount({
            end_data: [
                { id: 101, state: 0 },
                { id: 102, state: 2 },
                { id: 103, state: 1 },
                { id: 103, state: 1 },
            ],
        }),
        1,
    )
})

test('qualifying current shop purchase preserves funds/book/quota on codec or SQL failure; successful retry survives cold login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-shop-ending-')),
        file = path.join(dir, 'state.sqlite'),
        f = fixture('shop-ending-persist-current', file),
        row = rows.find((r) => r.commonCondition.endsWith('#1'))
    let original = f.protocol.encode.bind(f.protocol),
        cold
    try {
        fixedCurrency(f)
        f.training(301)
        f.complete(301)
        item(f, row)
        const before = f.store.load(f.session.id),
            sequences = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
        f.protocol.encode = (name, data) => {
            if (name === f.protocol.byId.get(6071).rsp) throw Error('shop ending codec')
            return original(name, data)
        }
        assert.throws(() => f.call('ShopBuyItems', req(row)), /shop ending codec/)
        f.protocol.encode = original
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), sequences)
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_ending_shop BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'shop ending SQL'); END",
        )
        assert.throws(() => f.call('ShopBuyItems', req(row)), /shop ending SQL/)
        f.store.db.exec('DROP TRIGGER reject_ending_shop')
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), sequences)
        f.call('ShopBuyItems', req(row))
        const paid = funds(f.state()),
            book = structuredClone(f.state().activities[60001].growup.end_data.complete_end),
            purchases = structuredClone(f.state().shopPurchases),
            pets = structuredClone(f.state().pets)
        f.store.close()
        const store = new Store(file),
            protocol = new Protocol(cfg.base),
            game = new Game(protocol, store, tables, { clock: () => NOW, rng: () => 0 }),
            session = {}
        cold = store
        const call = (name, data) => {
            const e = protocol.byName.get('CSProto' + name)
            return game.dispatch(session, { id: e.id, seq: 1, payload: protocol.encode(e.req, data) })
        }
        call('EnterGame', { open_id: 'shop-ending-persist-current' })
        const state = store.load(session.id).state
        assert.equal(funds(state), paid)
        assert.deepEqual(state.activities[60001].growup.end_data.complete_end, book)
        assert.deepEqual(state.shopPurchases, purchases)
        assert.deepEqual(state.pets, pets)
        const packets = call('ShopInfoReq', { shop_id: shopFor(row).shopId }),
            wire = protocol
                .decode(protocol.byId.get(6072).rsp, packets.find((x) => x.id === 6072).payload)
                .shop_info.shop_items.find((x) => x.goods_id === row.goodsId)
        assert.deepEqual(wire.unlock_progress, [1])
        assert.equal(wire.buy_times, 1)
    } finally {
        f.protocol.encode = original
        f.store.close()
        cold?.close()
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('ending qualification cannot override actual current item sale expiry or ordinary level gates', () => {
    const f = fixture('shop-ending-expiry-current', ':memory:')
    try {
        fixedCurrency(f)
        f.training(301)
        f.complete(301)
        const catalog = new ShopCatalog(tables),
            row = rows.find((x) => x.commonCondition.endsWith('#1')),
            shop = shopFor(row),
            slot = slotFor(row)
        assert.equal(catalog.item(shop, slot.slotId, f.state(), NOW).unlocked, true)
        const end = catalog.schedule(row).end
        assert(end > NOW)
        assert.equal(catalog.item(shop, slot.slotId, f.state(), end).in_time, false)
        const closed = new Game(f.protocol, f.store, tables, { clock: () => end, rng: () => 0 }),
            session = {}
        const enter = f.protocol.byName.get('CSProtoEnterGame')
        closed.dispatch(session, {
            id: enter.id,
            seq: 1,
            payload: f.protocol.encode(enter.req, { open_id: 'shop-ending-expiry-current' }),
        })
        const before = f.store.load(session.id),
            buy = f.protocol.byName.get('CSProtoShopBuyItems')
        assert.throws(
            () => closed.dispatch(session, { id: buy.id, seq: 2, payload: f.protocol.encode(buy.req, req(row)) }),
            (e) => e.code === ErrorCode.ShopNotOpen,
        )
        assert.deepEqual(f.store.load(session.id), before)
        const levelRow = tables.get('goods').find((x) => x.commonCondition === '2004#25'),
            levelSlot = slotFor(levelRow),
            levelShop = shopFor(levelRow)
        const low = structuredClone(f.state())
        low.player.basic_info.lv = 24
        assert.equal(catalog.item(levelShop, levelSlot.slotId, low, NOW).unlocked, false)
        low.player.basic_info.lv = 25
        assert.equal(catalog.item(levelShop, levelSlot.slotId, low, NOW).unlocked, true)
    } finally {
        f.store.close()
    }
})
