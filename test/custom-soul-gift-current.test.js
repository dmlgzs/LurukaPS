import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    boxes = tables.get('common_item').filter((r) => r.useType === 28)
function fixture() {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1,
        last = []
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) }
    }
    const dispatch = (r) => {
        last = game.dispatch(session, r)
        const e = protocol.byId.get(r.id)
        return e.rsp ? protocol.decode(e.rsp, last.find((p) => p.id === r.id).payload) : undefined
    }
    const call = (name, data) => dispatch(frame(name, data))
    call('EnterGame', { open_id: 'custom-soul-gift-current' })
    const gm = (command) => call('GMCommand', { command: Buffer.from(command).toString('base64') })
    return {
        protocol,
        store,
        session,
        game,
        frame,
        dispatch,
        call,
        gm,
        packets: () => last,
        state: () => store.load(session.id).state,
        saved: () => store.load(session.id),
        close: () => store.close(),
    }
}
const stock = (f, id) =>
    f
        .state()
        .player.sbag_infos.items.filter((r) => r.itemid === id)
        .reduce((n, r) => n + r.itemnum, 0)
const souls = (f) => f.state().player.soulessence_infos.soulessences
class NativeOwnedSoulModel {
    owned = new Map()
    shown = 0
    consume(f, packets) {
        for (const p of packets) {
            const e = f.protocol.byId.get(p.id),
                v = e.rsp ? f.protocol.decode(e.rsp, p.payload) : {}
            const data = p.id === 5001 ? v.data : p.id === 5008 ? v : null
            for (const r of data?.soulessence_infos?.soulessences ?? []) this.owned.set(String(r.guid), r)
            if (p.id === 6030)
                for (const r of v.rewards ?? [])
                    if (r.itemtype === 9) {
                        assert(this.owned.has(r.guid), 'new soul profile must exist before the real selector callback')
                        assert.equal(this.owned.get(r.guid).id, r.itemid)
                        this.shown += r.itemnum
                    }
        }
    }
}
test('both current28 boxes and all15 current choices use the public UseItem args9/id contract, with unique profiles before ACK', () => {
    assert.deepEqual(
        boxes.map((r) => r.id),
        [1520900, 1520901],
    )
    const f = fixture(),
        model = new NativeOwnedSoulModel()
    try {
        model.consume(f, f.packets())
        const before = souls(f).length
        let used = 0
        for (const box of boxes) {
            const choices = box.giftBagReward.split('|').map((x) => x.split('#').map(Number))
            f.gm(`item ${box.id} ${choices.length}`)
            model.consume(f, f.packets())
            assert.equal(stock(f, box.id), choices.length)
            for (const [type, id, num] of choices) {
                assert.equal(type, 9)
                assert.equal(num, 1)
                assert(tables.find('soulessence', id))
                const result = f.call('UseItem', { itemid: box.id, num: 1, args: [String(type), String(id)] })
                assert.equal(result.rewards.length, 1)
                assert.equal(result.rewards[0].itemid, id)
                model.consume(f, f.packets())
                used++
            }
            assert.equal(stock(f, box.id), 0)
        }
        assert.equal(used, 15)
        assert.equal(souls(f).length - before, 15)
        assert.equal(model.shown, 15)
        assert.equal(new Set(souls(f).map((r) => r.guid)).size, souls(f).length)
        const next = {},
            coldPackets = f.game.dispatch(next, f.frame('EnterGame', { open_id: 'custom-soul-gift-current' })),
            cold = new NativeOwnedSoulModel()
        cold.consume(f, coldPackets)
        assert.equal(cold.owned.size, souls(f).length)
        assert.equal(cold.shown, 0, 'cold login does not replay a paid selection reward')
        assert(coldPackets.every((p) => p.id !== 6030))
    } finally {
        f.close()
    }
})
test('invalid choice/type/arguments/missing stock and unrecovered Hero29 all reject without consuming source assets', () => {
    const f = fixture()
    try {
        f.gm('item 1520900 2')
        f.gm('item 1520902 1')
        for (const [request, code] of [
            [{ itemid: 1520900, num: 1, args: [] }, ErrorCode.SelectGiftArgsSize],
            [{ itemid: 1520900, num: 1, args: ['9'] }, ErrorCode.SelectGiftArgsSize],
            [{ itemid: 1520900, num: 1, args: ['1', '10237'] }, ErrorCode.SelectGiftItemNotExist],
            [{ itemid: 1520900, num: 1, args: ['9', '10032'] }, ErrorCode.SelectGiftItemNotExist],
            [{ itemid: 1520900, num: 3, args: ['9', '10237'] }, ErrorCode.ItemNotEnough],
            [{ itemid: 1520902, num: 1, args: ['1', '101003'] }, ErrorCode.FunctionClosed],
        ]) {
            const before = f.saved()
            assert.throws(() => f.call('UseItem', request), { code })
            assert.deepEqual(f.saved(), before)
        }
    } finally {
        f.close()
    }
})
test('current published5000 capacity admits the last slot and refuses the next with original box and allocator intact', () => {
    const f = fixture()
    try {
        const cap = Number(tables.get('game').find((r) => r.title === 'BAG_LIMIT_SOULESSENCE').value)
        assert.equal(cap, 5000)
        let needed = cap - 1 - souls(f).length
        while (needed > 0) {
            const n = Math.min(needed, 1000)
            f.gm('give 9 10237 ' + n)
            needed -= n
        }
        f.gm('item 1520900 2')
        f.call('UseItem', { itemid: 1520900, num: 1, args: ['9', '10237'] })
        assert.equal(souls(f).length, cap)
        assert.equal(stock(f, 1520900), 1)
        const before = f.saved()
        assert.throws(() => f.call('UseItem', { itemid: 1520900, num: 1, args: ['9', '10237'] }), {
            code: ErrorCode.SoulEssenceBagFull,
        })
        assert.deepEqual(f.saved(), before)
    } finally {
        f.close()
    }
})
test('real reward codec and SQL failure roll back soul profile/box/allocator/revision, and retry still publishes the uncached new profile before callback', () => {
    const f = fixture(),
        model = new NativeOwnedSoulModel()
    try {
        model.consume(f, f.packets())
        f.gm('item 1520900 1')
        model.consume(f, f.packets())
        const before = f.saved(),
            request = f.frame('UseItem', { itemid: 1520900, num: 1, args: ['9', '10237'] }),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byId.get(6030).rsp) throw Error('soul-gift-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.dispatch(request), /soul-gift-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.saved(), before)
        f.store.db.exec(
            "CREATE TRIGGER soul_gift_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'soul-gift-sql'); END",
        )
        try {
            assert.throws(() => f.dispatch(request), /soul-gift-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER soul_gift_abort')
        }
        assert.deepEqual(f.saved(), before)
        f.dispatch(request)
        model.consume(f, f.packets())
        assert.equal(model.shown, 1)
        assert.equal(stock(f, 1520900), 0)
        assert.equal(souls(f).length, before.state.player.soulessence_infos.soulessences.length + 1)
        const after = f.saved()
        assert.throws(() => f.dispatch(request), { code: ErrorCode.ItemNotEnough })
        assert.deepEqual(f.saved(), after)
    } finally {
        f.close()
    }
})
