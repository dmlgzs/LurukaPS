import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { exchangeCatalogue } from '../src/home-exchange.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const choices = [...exchangeCatalogue(tables).items.values()].filter(
    (row) => row.type === 3 && tables.find('common_item', row.itemId),
)
const products = [...new Map(choices.map((row) => [row.itemId, row])).values()].slice(0, 2)
assert.equal(products.length, 2)
function fixture(name) {
    const store = new Store(':memory:'),
        session = {},
        time = { now: 1795629881 },
        game = new Game(protocol, store, tables, { clock: () => time.now, rng: (min) => min })
    let seq = 1
    const call = (name, data = {}, peer = session) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(peer, {
            id: row.id,
            seq: seq++,
            payload: row.req ? protocol.encode(row.req, data) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'clear-exchange-' + name })
    store.transact(session.id, 0, (s) => {
        s.home.level = 6
        s.player.basic_info.lv = 36
        grantRewards(
            tables,
            s,
            products.map((row) => ({ itemtype: 3, itemid: row.itemId, itemnum: 30 })),
        )
    })
    game.tick(session.id, session)
    assert.equal(state().mall?.popupQueue?.length ?? 0, 0)
    assert.equal(state().mall?.pendingPopup, undefined)
    const warm = call('GetRechargePopupData').find(
        (p) => p.id === protocol.byName.get('CSProtoGetRechargePopupData').id,
    )
    assert.equal(protocol.decode(protocol.byId.get(warm.id).rsp, warm.payload).popup_id ?? 0, 0)
    const stock = () => structuredClone(state().player.sbag_infos.items),
        wallet = () => structuredClone(state().player.attr_infos.attrs),
        sql = () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id)
    return {
        store,
        session,
        time,
        game,
        call,
        state,
        stock,
        wallet,
        sql,
        add: (row, num) => call('CSAddExchangeObj', { id: row.id, num, type: 3 }),
        reopen: () => {
            const peer = {}
            return call('EnterGame', { open_id: 'clear-exchange-' + name, reconnect: true }, peer)
        },
    }
}
const decode = (frame) => protocol.decode(protocol.byId.get(frame.id).rsp, frame.payload)
const ordered = (packets, stock) => {
    const ack = packets.findIndex((p) => p.id === 6201),
        bag = packets.findIndex((p) => p.id === 5008),
        box = packets.findIndex((p) => p.id === 6229)
    assert(ack >= 0 && bag >= 0 && box >= 0 && bag < ack && box < ack)
    assert.deepEqual(decode(packets[box]).obj_info ?? [], [])
    const changed = decode(packets[bag]).sbag_infos.items
    for (const item of stock) {
        const sent = changed.find((row) => String(row.guid) === String(item.guid))
        if (sent) assert.equal(sent.itemnum, item.itemnum)
    }
    assert(!packets.some((p) => [18048, 6228, 11880].includes(p.id)), 'return is not a sale reward or completion')
}
test('6201 actual shared selection returns all original material stacks before ACK; no sale or balance change; empty close and reopen are idempotent', () => {
    const f = fixture('all')
    try {
        // A real reservation must retain its original stack expiry on return.
        f.store.transact(f.session.id, 0, (s) => {
            s.player.sbag_infos.items.find((i) => i.itemid === products[0].itemId).deadtime = f.time.now + 10000
        })
        const stock = f.stock(),
            wallet = f.wallet(),
            history = structuredClone(f.state().homeExchange.history)
        f.add(products[0], 10)
        f.add(products[0], 5)
        f.add(products[1], 30)
        assert(f.state().homeExchange.box.length >= 2)
        const packets = f.call('CSCancelAllObj')
        ordered(packets, stock)
        assert.deepEqual(f.stock(), stock)
        assert.deepEqual(f.wallet(), wallet)
        assert.deepEqual(f.state().homeExchange.history, history)
        assert.deepEqual(f.state().homeExchange.box, [])
        const stable = structuredClone(f.state()),
            again = f.call('CSCancelAllObj')
        assert(again.some((p) => p.id === 6201))
        assert.deepEqual(f.state(), stable)
        f.reopen()
        assert.deepEqual(f.stock(), stock)
        assert.deepEqual(f.state().homeExchange.box, [])
    } finally {
        f.store.close()
    }
})
test('Native isSwitch close sends no6201 between sell/order; reopening common box retains it until final close', () => {
    const f = fixture('tabs')
    try {
        const stock = f.stock()
        const added = f.add(products[0], 5)
        // Page Sell/Order.OnClose both branch on isSwitch: true skips ReqClear.
        // Only the UI source is modelled here, not a fabricated page-id field.
        const close = (isSwitch) => (isSwitch ? [] : f.call('CSCancelAllObj'))
        assert.deepEqual(close(true), [])
        const list = added.find((p) => p.id === 6229)
        assert.equal(decode(list).obj_info[0].num, 5)
        assert.equal(f.state().homeExchange.box[0].num, 5)
        close(false)
        assert.deepEqual(f.stock(), stock)
        f.add(products[1], 2)
        close(false)
        assert.deepEqual(f.stock(), stock)
    } finally {
        f.store.close()
    }
})
test('close after midnight cannot refund departed shipment; only new editable reservations return, then scheduled settlement remains single', () => {
    const f = fixture('depart')
    try {
        const stock = f.stock()
        f.add(products[0], 4)
        const reserved = structuredClone(f.state().homeExchange.box[0])
        f.time.now = reserved.shippingAt + 1
        const close = f.call('CSCancelAllObj')
        assert(close.some((p) => p.id === 6201))
        assert.equal(f.state().homeExchange.shipments[0].items[0].num, 4)
        assert.deepEqual(f.state().homeExchange.box, [])
        const shippedStock = f.stock(),
            shipment = structuredClone(f.state().homeExchange.shipments)
        f.add(products[1], 3)
        f.call('CSCancelAllObj')
        assert.deepEqual(f.stock(), shippedStock)
        assert.deepEqual(f.state().homeExchange.shipments, shipment)
        const before = f.wallet()
        f.time.now = reserved.settleAt
        f.game.tick(f.session.id, f.session)
        assert.deepEqual(f.state().homeExchange.shipments, [])
        assert.notDeepEqual(f.wallet(), before)
        const after = f.wallet()
        f.call('CSCancelAllObj')
        f.game.tick(f.session.id, f.session)
        assert.deepEqual(f.wallet(), after)
        assert.notDeepEqual(f.stock(), stock)
    } finally {
        f.store.close()
    }
})
test('bad saved proof fails the entire clear without partially restoring another valid reservation', () => {
    const f = fixture('proof')
    try {
        f.add(products[0], 3)
        f.add(products[1], 2)
        f.store.transact(f.session.id, 0, (s) => {
            s.homeExchange.box[1].items[0].itemnum++
        })
        const before = structuredClone(f.state()),
            sql = f.sql()
        assert.throws(
            () => f.call('CSCancelAllObj'),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.sql(), sql)
    } finally {
        f.store.close()
    }
})
test('6201 ACK encoding and SQL failures restore exact bag/selection/receipts; retry and cold login never duplicate returned stacks', () => {
    for (const fault of ['codec', 'sql']) {
        const f = fixture(fault)
        try {
            f.add(products[0], 7)
            f.add(products[1], 30)
            const before = structuredClone(f.state()),
                sql = f.sql(),
                encode = protocol.encode
            if (fault === 'codec')
                protocol.encode = function (type, value) {
                    if (type === protocol.byId.get(6201).rsp && value && !Object.keys(value).length)
                        throw Error('clear ACK codec failure')
                    return encode.call(this, type, value)
                }
            else
                f.store.db.exec(
                    "CREATE TRIGGER fail_clear BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'clear SQL failure'); END",
                )
            try {
                assert.throws(
                    () => f.call('CSCancelAllObj'),
                    new RegExp('clear ' + (fault === 'codec' ? 'ACK codec' : 'SQL') + ' failure'),
                )
            } finally {
                protocol.encode = encode
                if (fault === 'sql') f.store.db.exec('DROP TRIGGER fail_clear')
            }
            assert.deepEqual(f.state(), before)
            assert.deepEqual(f.sql(), sql)
            f.call('CSCancelAllObj')
            const returned = f.stock(),
                wallet = f.wallet()
            f.call('CSCancelAllObj')
            f.reopen()
            assert.deepEqual(f.stock(), returned)
            assert.deepEqual(f.wallet(), wallet)
            assert.deepEqual(f.state().homeExchange.box, [])
        } finally {
            f.store.close()
        }
    }
})
