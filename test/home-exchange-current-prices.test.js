import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { grantRewards } from '../src/rewards.js'
import { exchangeCatalogue, exchangeItemConfig, exchangeUnitPrice } from '../src/home-exchange.js'
import { ErrorCode } from '../src/error-codes.js'
import { homeOrderFixture } from './home-order-progress-fixture.js'

test('current external prices95/100/150 are authoritative for every ID without mutating source rows', () => {
    const external = new Tables(configuration().tables)
    const rows = external.get('home_exchange_item'),
        before = JSON.stringify(rows)
    for (const id of [10310342, 10360011])
        for (const price of [95, 100, 150]) {
            const view = new Tables(external.dir)
            const copied = rows.map((row) => Object.freeze(row.id === id ? { ...row, price } : { ...row }))
            view.cache.set('home_exchange_item', copied)
            const input = copied.find((row) => row.id === id),
                inputBefore = JSON.stringify(input)
            assert(input)
            assert.equal(exchangeItemConfig(view, id), input)
            assert.equal(exchangeItemConfig(view, id).price, price)
            assert.equal(exchangeUnitPrice(view, { homeExchange: { market: { changes: {} } } }, id), price)
            assert.equal(
                exchangeUnitPrice(view, { homeExchange: { market: { changes: { [id]: 35 } } } }, id),
                Math.ceil((price * 135) / 100),
            )
            assert.equal(JSON.stringify(input), inputBefore)
        }
    assert.equal(JSON.stringify(rows), before)
    assert.equal(
        external.find('home_exchange_item', 10310342),
        rows.find((row) => row.id === 10310342),
    )
    const invalid = new Tables(external.dir)
    invalid.cache.set(
        'home_exchange_item',
        rows.map((row) => (row.id === 10310342 ? { ...row, price: 0 } : row)),
    )
    assert.throws(
        () => exchangeItemConfig(invalid, 10310342),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('current6228/6229 market uses actual external ceil quote, debits inventory and settles once with codec rollback', () => {
    const account = 'exchange-current-authoritative-price',
        f = homeOrderFixture(account)
    const snapshot = () =>
        createHash('sha256')
            .update(JSON.stringify(f.store.load(f.session.id)))
            .digest('hex')
    const quantity = (id) =>
        f
            .state()
            .player.sbag_infos.items.filter((row) => row.itemid === id)
            .reduce((sum, row) => sum + row.itemnum, 0)
    const currency = exchangeCatalogue(f.tables).currency
    const balance = () =>
        BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === currency)?.attr_val ?? '0')
    const failCodec = (type, run) => {
        const encode = f.protocol.encode,
            before = snapshot()
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === type) throw Error(`injected ${type} codec failure`)
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(run, /codec failure/)
        } finally {
            f.protocol.encode = encode
        }
        assert.equal(snapshot(), before)
    }
    try {
        // Qualified progression fixture uses the current EXP model; it does not force an event or alter prices.
        const exp = f.tables
            .get('home_level')
            .filter((row) => row.id < 5)
            .reduce((sum, row) => sum + row.exp, 0)
        f.edit((state) =>
            grantRewards(f.tables, state, [
                { itemtype: 10, itemid: 1003, itemnum: exp - Number(state.home.experienceTotal) },
            ]),
        )
        assert.equal(f.state().home.level, 5)
        f.call('CSExchangeOrderBoard')
        const enter = f.protocol.byName.get('CSProtoEnterGame')
        const login = f.game.dispatch(
            {},
            { id: enter.id, seq: 1, payload: f.protocol.encode(enter.req, { open_id: account, reconnect: true }) },
        )
        assert(login.some((packet) => packet.id === 6228))
        assert(login.some((packet) => packet.id === 6229))
        const market = f.state().homeExchange.market
        const original = f.tables.get('home_exchange_item').find((row) => {
            const change = market.changes[row.id]
            return change > 0 && !Number.isInteger((row.price * (100 + change)) / 100)
        })
        assert(original, 'Actual configured event must offer a fractional quote vector')
        const externalBefore = JSON.stringify(original)
        const quoted = Math.ceil((original.price * (100 + market.changes[original.id])) / 100)
        assert.equal(exchangeUnitPrice(f.tables, f.state(), original.id), quoted)
        const num = 3
        f.edit((state) => grantRewards(f.tables, state, [{ itemtype: 3, itemid: original.itemId, itemnum: num }]))
        const stock = quantity(original.itemId),
            money = balance()
        const reserve = { id: original.id, num, type: original.type }
        failCodec('SCExchangeObj', () => f.call('CSAddExchangeObj', reserve))
        assert.equal(quantity(original.itemId), stock)
        assert.equal(balance(), money)
        const booked = f.call('CSAddExchangeObj', reserve)
        const box = f.protocol.decode('cs.SCExchangeObj', booked.find((packet) => packet.id === 6229).payload)
        assert(box.obj_info.some((row) => row.id === original.id && row.num === num))
        assert.equal(quantity(original.itemId), stock - num)
        assert.equal(f.state().homeExchange.box[0].unitPrice, quoted)
        assert.equal(f.state().homeExchange.box[0].num, num)
        failCodec('SCSettleImmediatelyAward', () => f.call('CSSettleImmediately'))
        assert.equal(balance(), money)
        assert.equal(quantity(original.itemId), stock - num)
        assert.equal(f.state().homeExchange.box[0].unitPrice, quoted)
        const settled = f.call('CSSettleImmediately')
        const reply = f.protocol.decode(
            'cs.SCSettleImmediatelyAward',
            settled.find((packet) => packet.id === 6224).payload,
        )
        assert(
            reply.award.rewards.some(
                (row) => row.itemtype === 10 && row.itemid === currency && row.itemnum === quoted * num,
            ),
        )
        assert.equal(reply.obj_info.obj_info.length, 0)
        assert.equal(balance() - money, BigInt(quoted * num))
        const info = f.protocol.decode('cs.SCHomeExchangeInfo', settled.find((packet) => packet.id === 6228).payload)
        assert(
            info.history.info.some(
                (row) => row.profit === quoted * num && row.settle_num === num && (row.extra_num ?? 0) === 0,
            ),
        )
        const history = JSON.stringify(f.state().homeExchange.history),
            paid = balance()
        const again = f.call('CSSettleImmediately')
        assert.equal(
            f.protocol.decode('cs.SCSettleImmediatelyAward', again.find((packet) => packet.id === 6224).payload).award
                .rewards.length,
            0,
        )
        assert.equal(balance(), paid)
        assert.equal(JSON.stringify(f.state().homeExchange.history), history)
        assert.equal(quantity(original.itemId), stock - num)
        assert.equal(JSON.stringify(original), externalBefore)
        assert.equal(f.tables.find('home_exchange_item', original.id), original)
    } finally {
        f.close()
    }
})
