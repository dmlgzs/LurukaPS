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
import { ErrorCode } from '../src/error-codes.js'
import { ShopGoodsTips } from '../src/shop-goods-tips.js'

const config = configuration(), tables = new Tables(config.tables), protocol = new Protocol(config.base)
const request = { shop_id: 502, slot_id: 502001, goods_id: 502001 }
const payload = (packets) => protocol.decode('SCShopGoodsTipSync', packets.find((packet) => packet.id === 6075).payload)
function setup(filename = ':memory:', account = 'shop-tips') {
    let now = 1800000000, seq = 1
    const store = new Store(filename), game = new Game(protocol, store, tables, { clock: () => now }), session = {}
    const call = (name, data) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, pushSeq: 0, payload: protocol.encode(entry.req, data) })
    }
    const login = call('EnterGame', { open_id: account })
    return { store, game, session, call, login, advance: (n) => { now += n } }
}

test('fresh login sends an empty full replacement and reading persists slot IDs with an empty 6074 acknowledgement', () => {
    const env = setup()
    try {
        assert.deepEqual(payload(env.login), { tipInfos: [], isAll: true })
        const packets = env.call('ShopGoodsTipReq', request)
        assert.deepEqual(protocol.decode('ProtoNullRsp', packets.find((packet) => packet.id === 6074).payload), {})
        assert.deepEqual(payload(packets), { tipInfos: [502001], isAll: true })
        assert.deepEqual(env.store.load(env.session.id).state.shopGoodsTips, { 502001: { shop_id: 502, goods_id: 502001 } })
        env.call('ShopGoodsTipReq', request)
        assert.equal(Object.keys(env.store.load(env.session.id).state.shopGoodsTips).length, 1)
        assert(!packets.some((packet) => packet.id === 1), 'does not send player/item reward snapshots')
    } finally { env.store.close() }
})

test('reading is not purchase admission: locked/price/stock state is not changed and stock refresh does not clear read status', () => {
    const env = setup()
    try {
        const before = env.store.load(env.session.id).state
        const locked = { shop_id: 502, slot_id: 502002, goods_id: 502002 }
        env.call('ShopGoodsTipReq', locked)
        env.advance(62 * 86400)
        assert.deepEqual(payload(env.call('ShopInfoReq', { shop_id: 502 })), { tipInfos: [502002], isAll: true })
        const after = env.store.load(env.session.id).state
        assert.deepEqual(after.player, before.player)
        assert.deepEqual(after.shopPurchases, before.shopPurchases)
    } finally { env.store.close() }
})

test('wrong stores, crossed slots, wrong goods and missing identities roll back the whole request', () => {
    const env = setup()
    try {
        env.call('ShopGoodsTipReq', request)
        for (const [data, code] of [
            [{ ...request, shop_id: 999999 }, ErrorCode.ShopConfNotExist],
            [{ ...request, shop_id: 504 }, ErrorCode.InvalidArgument],
            [{ ...request, slot_id: 999999 }, ErrorCode.InvalidArgument],
            [{ ...request, goods_id: 502002 }, ErrorCode.InvalidArgument],
            [{ ...request, slot_id: 0 }, ErrorCode.InvalidArgument],
            [{ shop_id: 502, slot_id: 502001 }, ErrorCode.InvalidArgument],
        ]) {
            const before = env.store.load(env.session.id)
            assert.throws(() => env.call('ShopGoodsTipReq', data), (error) => error.code === code)
            assert.deepEqual(env.store.load(env.session.id), before)
        }
    } finally { env.store.close() }
})

test('shop list and individual info send the entire read set so a stale local set can be replaced', () => {
    const env = setup()
    try {
        env.call('ShopGoodsTipReq', { shop_id: 504, slot_id: 504001, goods_id: 504001 })
        env.call('ShopGoodsTipReq', request)
        const expected = { tipInfos: [502001, 504001], isAll: true }
        assert.deepEqual(payload(env.call('ListShopArrayItems', { shop_ids: [502] })), expected)
        assert.deepEqual(payload(env.call('ShopInfoReq', { shop_id: 504 })), expected)
    } finally { env.store.close() }
})

test('temporary SQLite reopen restores reads per account and the wire codec round trips the original camel-case fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-shop-tips-')), filename = path.join(dir, 'test.sqlite')
    let env
    try {
        env = setup(filename)
        env.call('ShopGoodsTipReq', request)
        env.store.close(); env = null
        env = setup(filename)
        assert.deepEqual(payload(env.login), { tipInfos: [502001], isAll: true })
        env.store.close(); env = null
        env = setup(filename, 'another-player')
        assert.deepEqual(payload(env.login), { tipInfos: [], isAll: true })
    } finally { env?.store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

function fixture() {
    const rows = {
        shop: [{ shopId: 10, goodsList: '71' }],
        shop_slot: [{ slotId: 71, slotType: 1, slotParam: 900 }],
        goods: [{ goodsId: 900 }],
    }
    return { rows, catalog: new ShopGoodsTips({ get: (name) => rows[name] }) }
}
test('slot and goods are independent identities; reassigned or removed goods lose read status without granting new products', () => {
    const { rows, catalog } = fixture(), state = {}
    assert.deepEqual(catalog.read(state, { shop_id: 10, slot_id: 71, goods_id: 900 }), { tipInfos: [71], isAll: true })
    rows.shop_slot[0].slotParam = 901
    assert.deepEqual(catalog.snapshot(state), { tipInfos: [], isAll: true })
    assert.throws(() => catalog.read(state, { shop_id: 10, slot_id: 71, goods_id: 901 }), (e) => e.code === ErrorCode.ShopGoodsConfNotExist)
    rows.shop_slot[0].slotType = 2
    assert.throws(() => catalog.read(state, { shop_id: 10, slot_id: 71, goods_id: 900 }), (e) => e.code === ErrorCode.InvalidProtoID)
})

test('damaged saved tip identities or ambiguous table IDs are configuration errors, not silent success', () => {
    const { catalog, rows } = fixture()
    for (const shopGoodsTips of [null, [], { x: {} }, { 71: null }, { '071': { shop_id: 10, goods_id: 900 } }, { 71: { shop_id: 10, goods_id: 0 } }]) {
        assert.throws(() => catalog.snapshot({ shopGoodsTips }), (e) => e.code === ErrorCode.GameConfig)
    }
    rows.shop_slot.push({ ...rows.shop_slot[0] })
    assert.throws(() => new ShopGoodsTips({ get: (name) => rows[name] }), (e) => e.code === ErrorCode.GameConfig)
})
