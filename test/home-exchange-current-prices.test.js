import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { exchangeItemConfig } from '../src/home-exchange.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('current transaction10310342 uses the fresh100 price without changing the external table or silently replacing future data', () => {
    const original = tables.find('home_exchange_item', 10310342),
        fake = (price) => {
            const result = Object.create(tables)
            result.get = (name) =>
                name === 'home_exchange_item'
                    ? tables.get(name).map((row) => (row.id === 10310342 ? { ...row, price } : row))
                    : tables.get(name)
            return result
        }
    assert.equal(exchangeItemConfig(fake(95), 10310342).price, 100)
    assert.equal(exchangeItemConfig(fake(100), 10310342).price, 100)
    assert.throws(
        () => exchangeItemConfig(fake(150), 10310342),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.equal(tables.find('home_exchange_item', 10310342), original)
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1792584000, rng: (min) => min }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'exchange-current-price' })
        call('CSExchangeObjInfo')
        store.transact(session.id, 0, (s) => {
            s.homeExchange.market.changes = {}
            grantRewards(tables, s, [{ itemtype: 3, itemid: original.itemId, itemnum: 1 }])
        })
        const value = () =>
                Number(
                    store.load(session.id).state.player.attr_infos.attrs.find((a) => a.attr_id === 103)?.attr_val ?? 0,
                ),
            before = value()
        call('CSAddExchangeObj', { id: original.id, num: 1, type: 3 })
        assert.equal(store.load(session.id).state.homeExchange.box[0].unitPrice, 100)
        call('CSSettleImmediately')
        assert.equal(value() - before, 100)
    } finally {
        store.close()
    }
})
