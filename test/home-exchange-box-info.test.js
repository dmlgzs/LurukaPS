import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { exchangeClock, exchangeCatalogue } from '../src/home-exchange.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('6221 publishes stable table-driven market prices and actual shipment data before its null ACK', () => {
    const store = new Store(':memory:'),
        session = {}
    let now = 1792598400,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now, rng: (min) => min })
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'exchange-box-info' })
        const before = state().player
        const result = call('CSExchangeObjInfo'),
            news = result.find((p) => p.id === 6219).data,
            box = result.find((p) => p.id === 6229).data
        assert(result.findIndex((p) => p.id === 6229) < result.findIndex((p) => p.id === 6221))
        assert.equal(news.nowEventId, tables.get('home_exchange_event')[0].EventId)
        const event = tables.get('home_exchange_event').find((row) => row.EventId === news.nowEventId),
            tags = event.PriceIncreaseTag.split('|').map(Number)
        const expected = tables.get('home_exchange_item').filter((row) =>
            String(row.Tag)
                .split('|')
                .map(Number)
                .some((tag) => tags.includes(tag)),
        )
        assert.equal(news.cinfo.length, expected.length)
        assert(news.cinfo.every((row) => row.isupper && row.percent === 50))
        assert.deepEqual(box.obj_info, [])
        assert.equal(box.settle_num, 0)
        assert.equal(exchangeCatalogue(tables).currency, 103)
        assert.deepEqual(call('CSExchangeObjInfo').find((p) => p.id === 6219).data, news)
        assert.deepEqual(state().player, before)
        const market = structuredClone(state().homeExchange.market)
        now = exchangeClock(tables, now).settleAt
        const next = call('CSExchangeObjInfo').find((p) => p.id === 6219).data
        assert.equal(next.nowEventId, market.nextEventId)
        assert.notEqual(next.NextEventId, next.nowEventId)
    } finally {
        store.close()
    }
})
test('exchange shipment view returns actual escrow quantities and only current-week principal income', () => {
    const store = new Store(':memory:'),
        session = {}
    let seq = 1
    const now = 1792598400,
        game = new Game(protocol, store, tables, { clock: () => now })
    const call = (n, r = {}) => {
        const e = protocol.byName.get('CSProto' + n)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'exchange-box-saved' })
        const clock = exchangeClock(tables, now),
            dayTime = clock.businessDay * 86400 - 8 * 3600 + 4 * 3600
        store.transact(session.id, 0, (s) => {
            s.homeExchange = {
                box: [{ id: 10360011, num: 71 }],
                history: [
                    { history_time: dayTime, profit: 142, settle_num: 71, extra_num: 7 },
                    { history_time: dayTime - 10 * 86400, profit: 999, settle_num: 1, extra_num: 0 },
                ],
            }
        })
        const result = call('CSExchangeObjInfo').find((p) => p.id === 6229)
        const data = protocol.decode(protocol.byId.get(6229).rsp, result.payload)
        assert.deepEqual(data.obj_info, [{ id: 10360011, num: 71 }])
        assert.equal(data.settle_num, 142)
    } finally {
        store.close()
    }
})
