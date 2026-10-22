import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const conf = configuration(),
    tables = new Tables(conf.tables),
    protocol = new Protocol(conf.base)
function setup() {
    let now = 1792678000
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now })
    let seq = 1,
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: protocol.encode(e.req, r) })
    }
    let login = call('EnterGame', { open_id: 'snack-bag' })
    store.transact(session.id, 0, (s) => {
        s.player.sbag_infos.items = [
            { itemid: 9000101, itemnum: 10 },
            { itemid: 9000102, itemnum: 10 },
            { itemid: 100000, itemnum: 5 },
        ]
    })
    return {
        store,
        session,
        call,
        login,
        relogin: () => {
            session = {}
            return call('EnterGame', { open_id: 'snack-bag' })
        },
        state: () => store.load(session.id).state,
        now: () => now,
        advance: (n) => (now += n),
    }
}
function payload(packets) {
    const id = protocol.byName.get('CSProtoAllSnackBagInfoSync').id,
        p = packets.find((p) => p.id === id)
    assert.ok(p)
    return protocol.decode('AllSnackBagInfo', p.payload)
}
const add = (slot, id, num) => ({ source_bag: 1, source_slot: slot, operate_type: 1, item_id: id, item_num: num })
const sub = (slot) => ({ source_bag: 1, source_slot: slot, operate_type: 0 })
test('login supplies four real zero-based slots and table-driven default thresholds', () => {
    const f = setup()
    try {
        let bag = payload(f.login)
        assert.deepEqual(
            bag.bags.map((b) => b.type),
            [1, 2],
        )
        assert.deepEqual(
            bag.bags.map((b) => b.num),
            [31, 67],
        )
        assert.ok(bag.bags.every((b) => b.items.length === 4 && b.items.every((i) => !i.item_num)))
    } finally {
        f.store.close()
    }
})
test('current mount UI additions are increments and whole-slot removal refunds exact stock without duplicate returns', () => {
    const f = setup()
    try {
        f.call('OperateSnackBag', add(0, 9000101, 2))
        const packets = f.call('OperateSnackBag', add(0, 9000101, 3))
        let s = f.state()
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 9000101).itemnum, 5)
        assert.equal(payload(packets).bags[0].items[0].item_num, 5)
        let sync = packets.findIndex((p) => p.id === protocol.byName.get('CSProtoAllSnackBagInfoSync').id),
            ack = packets.findIndex((p) => p.id === 6562)
        assert.ok(sync >= 0 && ack >= 0 && sync < ack)
        f.call('OperateSnackBag', sub(0))
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 9000101).itemnum, 10)
        f.call('OperateSnackBag', sub(0))
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 9000101).itemnum, 10)
    } finally {
        f.store.close()
    }
})
test('replacing a filled snack slot returns the previous item then swaps preserve counts and slot positions', () => {
    const f = setup()
    try {
        f.call('OperateSnackBag', add(1, 9000101, 4))
        f.call('OperateSnackBag', add(1, 9000102, 2))
        let s = f.state()
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 9000101).itemnum, 10)
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 9000102).itemnum, 8)
        f.call('OperateSnackBag', add(3, 9000101, 3))
        f.call('OperateSnackBag', { source_bag: 1, source_slot: 1, target_bag: 1, target_slot: 3, operate_type: 2 })
        s = f.state()
        assert.deepEqual(
            s.snackBags[1].items.map((i) => i.item_id),
            [0, 9000101, 0, 9000102],
        )
        f.call('OperateSnackBag', sub(1))
        f.call('OperateSnackBag', sub(3))
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 9000101).itemnum, 10)
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 9000102).itemnum, 10)
    } finally {
        f.store.close()
    }
})
test('invalid category, slot, quantity, insufficient stock and unproven hero storage are atomic failures', () => {
    const f = setup()
    try {
        for (const [r, code] of [
            [add(4, 9000101, 1), ErrorCode.MountSnackSlotLimit],
            [add(0, 9000101, 0), ErrorCode.MountSnackItemAddZero],
            [add(0, 9000101, 1000), ErrorCode.SnackBagInvalidArg],
            [add(0, 100000, 1), ErrorCode.MountSnackItemSubTypeError],
            [add(0, 9000101, 11), ErrorCode.ItemNotEnough],
            [{ ...add(0, 9000101, 1), source_bag: 2 }, ErrorCode.FunctionClosed],
            [{ ...sub(0), item_num: 1 }, ErrorCode.SnackBagInvalidArg],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('OperateSnackBag', r),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('food expiry and original inventory identities survive storage and expired food cannot be laundered', () => {
    const f = setup()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.sbag_infos.items[0].deadtime = f.now() + 10
        })
        f.call('OperateSnackBag', add(0, 9000101, 3))
        const guid = f.state().snackBags[1].items[0].source_stacks[0].guid
        f.call('OperateSnackBag', sub(0))
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.guid === guid).deadtime, f.now() + 10)
        f.call('OperateSnackBag', add(0, 9000101, 3))
        f.advance(11)
        f.call('OperateSnackBag', sub(0))
        const item = f.state().player.sbag_infos.items.find((i) => i.guid === guid)
        assert.equal(item.itemnum, 7)
        assert.ok(item.deadtime < f.now())
        assert.equal(f.state().snackBags[1].items[0].item_num, 0)
    } finally {
        f.store.close()
    }
})
test('snack storage persists across login and a failed bag-sync encoding rolls back both inventories', () => {
    const f = setup()
    try {
        f.call('OperateSnackBag', add(0, 9000101, 3))
        f.store.flushPending()
        const saved = JSON.parse(
            f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session.id).state,
        )
        assert.equal(saved.snackBags[1].items[0].item_num, 3)
        let returned = f.relogin()
        assert.equal(payload(returned).bags[0].items[0].item_num, 3)
        const before = f.state(),
            old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('CSProtoAllSnackBagInfoSync').rsp) throw Error('snack codec failure')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.call('OperateSnackBag', sub(0)), /codec failure/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
