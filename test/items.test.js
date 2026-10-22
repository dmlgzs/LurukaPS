import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const c = configuration(),
    tables = new Tables(c.tables),
    protocol = new Protocol(c.base)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'items' })
    store.transact(session.id, 0, (s) => {
        s.player.sbag_infos.items = [
            { itemid: 100000, itemnum: 3 },
            { itemid: 100010, itemnum: 2 },
            { itemid: 309000, itemnum: 3 },
            { itemid: 9000, itemnum: 1 },
        ]
        s.player.attr_infos.attrs = [{ attr_id: 3, attr_val: '900' }]
    })
    return { store, session, call }
}
test('stamina consumables and batch use debit stock and allow final-item overfill', () => {
    const { store, session, call } = setup()
    try {
        const result = call('BatchUseItem', {
            items: [
                { itemid: 100000, num: 1 },
                { itemid: 100010, num: 1 },
            ],
        })
        let s = store.load(session.id).state
        assert.equal(s.player.attr_infos.attrs[0].attr_val, '1020')
        assert.equal(s.player.sbag_infos.items[0].itemnum, 2)
        assert.equal(s.player.sbag_infos.items[1].itemnum, 1)
        const reply = protocol.decode('Rewards', result.find((p) => p.id === 6038).payload)
        assert.equal(reply.rewards[0].itemnum, 120)
        const before = store.load(session.id)
        assert.throws(() => call('UseItem', { itemid: 100000, num: 1 }), /limit/)
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})
test('oversized, mixed-invalid-gift and zero-quantity uses are atomic failures', () => {
    const { store, session, call } = setup()
    try {
        const before = store.load(session.id)
        for (const req of [
            { items: [{ itemid: 100000, num: 3 }] },
            {
                items: [
                    { itemid: 100000, num: 1 },
                    { itemid: 9000, num: 1 },
                ],
            },
            { items: [{ itemid: 100000, num: 0 }] },
        ]) {
            assert.throws(() => call('BatchUseItem', req))
            assert.deepEqual(store.load(session.id), before)
        }
    } finally {
        store.close()
    }
})
test('fixed input-item exchange multiplies configured costs and rewards', () => {
    const { store, session, call } = setup()
    try {
        const packets = call('ExchangeItem', { item_type: 3, item_id: 309000, item_num: 2 })
        const s = store.load(session.id).state
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 309000).itemnum, 1)
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 308011).itemnum, 4)
        const reply = protocol.decode('Rewards', packets.find((p) => p.id === 6032).payload)
        assert.equal(reply.rewards[0].itemnum, 4)
        const before = store.load(session.id)
        assert.throws(() => call('ExchangeItem', { item_type: 3, item_id: 309000, item_num: 2 }))
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})
test('ambiguous exchange and invalid quantities cannot silently debit currency', () => {
    const { store, session, call } = setup()
    try {
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.diamond = 1000
        })
        const before = store.load(session.id)
        assert.throws(() => call('ExchangeItem', { item_type: 10, item_id: 1, item_num: 1 }), /Ambiguous/)
        assert.deepEqual(store.load(session.id), before)
        assert.throws(() => call('ExchangeItem', { item_type: 3, item_id: 309000, item_num: 0 }))
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})
