import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { itemGiftRewards } from '../src/item-gifts.js'
const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function setup(items) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: protocol.encode(e.req, request) })
    }
    call('EnterGame', { open_id: 'gift-test' })
    store.transact(session.id, 0, (state) => {
        state.player.sbag_infos.items = items
        state.player.basic_info.gold = 0
    })
    return { store, session, call, game, state: () => store.load(session.id).state }
}
function reply(packets, id = 6038) {
    const index = packets.findIndex((p) => p.id === id)
    assert.ok(index >= 0)
    return protocol.decode('Rewards', packets[index].payload)
}
test('talent material batch opens multiple choices from the same box and persists real inventory', () => {
    const c = setup([
        { itemid: 1520001, itemnum: 3 },
        { itemid: 1520010, itemnum: 1 },
    ])
    try {
        const r = reply(
            c.call('BatchUseItem', {
                items: [
                    { itemid: 1520001, num: 2, args: ['3', '1530001'] },
                    { itemid: 1520001, num: 1, args: ['3', '1530002'] },
                    { itemid: 1520010, num: 1 },
                ],
            }),
        )
        const s = c.state()
        assert.equal(r.src, 1)
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 1520001).itemnum, 0)
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 1530001).itemnum, 2)
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 1530002).itemnum, 1)
        assert.equal(s.player.basic_info.gold, 5000)
        assert.ok(r.rewards.some((i) => i.itemid === 400001 && i.itemnum === 15))
    } finally {
        c.store.close()
    }
})
test('single-use self-selection shares the batch executor and returns a real equipment identity', () => {
    const c = setup([{ itemid: 1520900, itemnum: 1 }])
    try {
        const r = reply(c.call('UseItem', { itemid: 1520900, num: 1, args: ['9', '10237'] }), 6030)
        assert.equal(r.rewards[0].itemtype, 9)
        assert.ok(r.rewards[0].guid)
        assert.ok(
            c
                .state()
                .player.soulessence_infos.soulessences.some(
                    (i) => String(i.guid) === r.rewards[0].guid && i.id === 10237,
                ),
        )
    } finally {
        c.store.close()
    }
})
test('independent random gift rolls use table weights and cannot be multiplied from one roll', () => {
    const item = tables.find('common_item', 9001)
    let roll = 0
    const requests = []
    const rewards = itemGiftRewards(tables, item, { num: 2, args: [] }, (max) => {
        requests.push(max)
        return roll++ === 0 ? 0 : max - 1
    })
    assert.equal(rewards.length, 2)
    assert.notEqual(rewards[0].itemid, rewards[1].itemid)
    assert.ok(requests.length >= 4)
})
test('every current selectable gift uses its own visible choice and configured quantity', () => {
    for (const item of tables.get('common_item').filter((r) => [3, 26].includes(r.useType) && r.giftBagReward))
        for (const token of item.giftBagReward.split('|')) {
            const [type, id, num] = token.split('#').map(Number)
            const rewards = itemGiftRewards(tables, item, { num: 2, args: [String(type), String(id)] }, () => 0)
            assert.equal(
                rewards.reduce((n, r) => n + r.itemnum, 0),
                num * 2,
            )
            assert.ok(rewards.every((r) => r.itemtype === type && r.itemid === id))
        }
})
test('invalid choices, argument shape, unsupported use types and later grant failure roll back the complete batch', () => {
    const c = setup([
        { itemid: 1520001, itemnum: 2 },
        { itemid: 10001, itemnum: 1 },
        { itemid: 9000, itemnum: 1 },
    ])
    try {
        for (const [items, code] of [
            [[{ itemid: 1520001, num: 1 }], ErrorCode.SelectGiftArgsSize],
            [[{ itemid: 1520001, num: 1, args: ['3', '400000'] }], ErrorCode.SelectGiftItemNotExist],
            [[{ itemid: 10001, num: 1, args: ['3', '400000'] }], ErrorCode.UseItemArgFail],
            [
                [
                    { itemid: 1520001, num: 1, args: ['3', '1530001'] },
                    { itemid: 9000, num: 1 },
                ],
                ErrorCode.GameConfig,
            ],
        ]) {
            const before = c.state()
            assert.throws(
                () => c.call('BatchUseItem', { items }),
                (e) => e.code === code,
            )
            assert.deepEqual(c.state(), before)
        }
    } finally {
        c.store.close()
    }
})
test('expired boxes and total stock aggregated across selections cannot be bypassed', () => {
    const c = setup([{ itemid: 1520001, itemnum: 1, deadtime: 1 }])
    try {
        const before = c.state()
        assert.throws(
            () => c.call('BatchUseItem', { items: [{ itemid: 1520001, num: 1, args: ['3', '1530001'] }] }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(c.state(), before)
        c.store.transact(c.session.id, 0, (s) => {
            s.player.sbag_infos.items[0].deadtime = 0
        })
        const fresh = c.state()
        assert.throws(
            () =>
                c.call('BatchUseItem', {
                    items: [
                        { itemid: 1520001, num: 1, args: ['3', '1530001'] },
                        { itemid: 1520001, num: 1, args: ['3', '1530002'] },
                    ],
                }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(c.state(), fresh)
    } finally {
        c.store.close()
    }
})
