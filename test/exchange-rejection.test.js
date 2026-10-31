import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { addItems } from '../src/inventory.js'
import { addHomeBuildings } from '../src/home.js'
import { ErrorCode } from '../src/error-codes.js'
import { encodeFrame, decodeFrame } from '../src/wire.js'

function fixture(name) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1,
        transform
    const get = tables.get.bind(tables)
    tables.get = (name) => (name === 'common_item_change' && transform ? transform(get(name)) : get(name))
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        addItems(s, [{ itemid: 309000, itemnum: 3 }])
        s.player.basic_info.diamond = 1000
        addHomeBuildings(tables, s, 10000, 3)
    })
    store.transact(
        session.id,
        0,
        (s) => {
            s.exchangeTestPending = 'independent-noop'
        },
        { defer: true },
    )
    const state = () => store.load(session.id).state
    const database = () =>
        Object.fromEntries(
            store.db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .all()
                .map(({ name }) => [
                    name,
                    store.db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all(),
                ]),
        )
    const reject = (request, expected) => {
        const before = store.load(session.id),
            sql = database(),
            changes = store.db.prepare('SELECT total_changes() AS n').get().n,
            pending = store.pending.get(session.id),
            borrowed = pending?.state
        let error
        try {
            call('ExchangeItem', request)
        } catch (e) {
            error = e
        }
        assert(error)
        assert.equal(error.code, expected)
        assert.deepEqual(store.load(session.id), before)
        assert.deepEqual(database(), sql)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes)
        assert.strictEqual(store.pending.get(session.id), pending)
        if (pending) assert.strictEqual(pending.state, borrowed)
        const response = decodeFrame(encodeFrame({ id: 6032, seq: 100, error: error.code }))
        assert.equal(response.error, expected)
        assert.equal(response.payload.length, 0)
    }
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        state,
        reject,
        transform: (fn) => {
            transform = fn
        },
        close: () => store.close(),
    }
}
test('registered6032 refuses unimplemented args and same-source selection with FunctionClosed and no state/SQL/sequence or reward changes', () => {
    const f = fixture('exchange-rejection-capability')
    try {
        assert.equal(f.tables.get('common_item_change').length, 40)
        f.reject({ item_type: 3, item_id: 309000, item_num: 1, args: [1] }, ErrorCode.FunctionClosed)
        f.reject({ item_type: 10, item_id: 1, item_num: 1 }, ErrorCode.FunctionClosed)
        // The original mixed source-category branch is intentionally pending:
        // real enum13 plus a valid building differs from a broken999 recipe,
        // so this diagnostic-only change does not relabel either as supported.
        f.transform((rows) => [
            ...rows,
            { id: 4000000000, itemType: 13, itemId: 10000, itemNum: 1, change: '3#300000#1' },
            { id: 4000000001, itemType: 999, itemId: 10000, itemNum: 1, change: '3#300000#1' },
        ])
        assert(f.tables.find('home_building', 10000))
        f.reject({ item_type: 13, item_id: 10000, item_num: 1 }, ErrorCode.InvalidProtoID)
        f.reject({ item_type: 999, item_id: 10000, item_num: 1 }, ErrorCode.InvalidProtoID)
    } finally {
        f.close()
    }
})
test('invalid request, absent recipe, insufficient stock and malformed recipe preserve their original error contracts', () => {
    const f = fixture('exchange-rejection-original-errors')
    try {
        f.reject({ item_type: 3, item_id: 309000, item_num: 0 }, ErrorCode.InvalidArgument)
        f.reject({ item_type: 0, item_id: 10000, item_num: 1 }, ErrorCode.InvalidArgument)
        f.reject({ item_type: 999, item_id: 10000, item_num: 1 }, ErrorCode.InvalidArgument)
        f.reject({ item_type: 3, item_id: 4294967295, item_num: 1 }, ErrorCode.InvalidArgument)
        f.reject({ item_type: 3, item_id: 309000, item_num: 4 }, ErrorCode.ItemNotEnough)
        f.reject({ item_type: 3, item_id: 309000, item_num: 0xffffffff }, ErrorCode.InvalidArgument)
        for (const patch of [{ itemNum: 0 }, { change: 'bad' }]) {
            f.transform((rows) => rows.map((r) => (r.itemType === 3 && r.itemId === 309000 ? { ...r, ...patch } : r)))
            f.reject({ item_type: 3, item_id: 309000, item_num: 1 }, ErrorCode.GameConfig)
        }
    } finally {
        f.close()
    }
})
test('representative current unique source retains batch cost/reward semantics and an empty args list', () => {
    const f = fixture('exchange-unique-success')
    try {
        const count = (id) =>
            f
                .state()
                .player.sbag_infos.items.filter((r) => r.itemid === id)
                .reduce((n, r) => n + r.itemnum, 0)
        const input = count(309000),
            output = count(308011),
            currency = f.state().player.basic_info.diamond
        const packets = f.call('ExchangeItem', { item_type: 3, item_id: 309000, item_num: 2, args: [] })
        assert.equal(count(309000), input - 2)
        assert.equal(count(308011), output + 4)
        assert.equal(f.state().player.basic_info.diamond, currency)
        const rewards = f.protocol.decode('Rewards', packets.find((p) => p.id === 6032).payload).rewards
        assert(rewards.some((r) => r.itemid === 308011 && r.itemnum === 4))
    } finally {
        f.close()
    }
})
