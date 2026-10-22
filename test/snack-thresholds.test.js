import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables)
    let session = {},
        seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'snack-threshold' })
    store.transact(session.id, 0, (s) => {
        s.player.sbag_infos.items = [{ itemid: 9000101, itemnum: 4 }]
    })
    return {
        store,
        call,
        state: () => store.load(session.id).state,
        relogin: () => {
            session = {}
            return call('EnterGame', { open_id: 'snack-threshold' })
        },
        saved: () => JSON.parse(store.db.prepare('SELECT state FROM players WHERE account_id=?').get(session.id).state),
    }
}
const sync = (packets) => {
    const e = protocol.byName.get('CSProtoAllSnackBagInfoSync'),
        packet = packets.find((p) => p.id === e.id)
    assert.ok(packet)
    return protocol.decode('AllSnackBagInfo', packet.payload)
}
test('6566 accepts UI minimum and table maximum for both known bags and syncs before ACK', () => {
    const f = setup()
    try {
        const packets = f.call('SetSnackBagNum', {
                info: [
                    { bag_type: 1, num: 0 },
                    { bag_type: 2, num: 100 },
                ],
            }),
            data = sync(packets)
        assert.deepEqual(
            data.bags.map((b) => b.num),
            [0, 100],
        )
        const push = packets.findIndex((p) => p.id === protocol.byName.get('CSProtoAllSnackBagInfoSync').id),
            ack = packets.findIndex((p) => p.id === 6566)
        assert.ok(push >= 0 && ack >= 0 && push < ack)
        f.store.flushPending()
        assert.equal(f.saved().snackBags[2].num, 100)
        assert.deepEqual(
            sync(f.relogin()).bags.map((b) => b.num),
            [0, 100],
        )
    } finally {
        f.store.close()
    }
})
test('threshold updates preserve existing food stock and provenance and never perform an automatic feed', () => {
    const f = setup()
    try {
        f.call('OperateSnackBag', { source_bag: 1, source_slot: 0, operate_type: 1, item_id: 9000101, item_num: 3 })
        const before = f.state()
        f.call('SetSnackBagNum', { info: [{ bag_type: 1, num: 100 }] })
        const after = f.state()
        assert.equal(after.snackBags[1].num, 100)
        assert.deepEqual(after.snackBags[1].items, before.snackBags[1].items)
        assert.deepEqual(after.player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(after.pets, before.pets)
        assert.equal(after.snackBags[2].num, 67)
    } finally {
        f.store.close()
    }
})
test('invalid types, duplicate bags and over-limit values atomically reject all entries', () => {
    const f = setup()
    try {
        for (const [info, code] of [
            [[], ErrorCode.SnackBagInvalidArg],
            [[{ bag_type: 3, num: 50 }], ErrorCode.MountSnackTypeError],
            [
                [
                    { bag_type: 1, num: 20 },
                    { bag_type: 1, num: 30 },
                ],
                ErrorCode.SnackBagInvalidArg,
            ],
            [
                [
                    { bag_type: 1, num: 20 },
                    { bag_type: 2, num: 101 },
                ],
                ErrorCode.MountSnackNumMaxLimit,
            ],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('SetSnackBagNum', { info }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('a failed threshold synchronization rolls back both threshold changes', () => {
    const f = setup()
    try {
        const before = f.state(),
            old = protocol.encode
        protocol.encode = function (name, payload) {
            if (name === protocol.byName.get('CSProtoAllSnackBagInfoSync').rsp) throw Error('threshold encoding failed')
            return old.call(this, name, payload)
        }
        try {
            assert.throws(
                () =>
                    f.call('SetSnackBagNum', {
                        info: [
                            { bag_type: 1, num: 50 },
                            { bag_type: 2, num: 60 },
                        ],
                    }),
                /encoding failed/,
            )
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
