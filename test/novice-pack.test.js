import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { prepareNovicePack } from '../src/novice-pack.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(file = ':memory:', initial = 1800000000) {
    let now = initial,
        seq = 1
    const store = new Store(file),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now, offlinePayments: true })
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'novice-pack' })
    return {
        store,
        session,
        call,
        state: () => store.load(session.id).state,
        now: () => now,
        setNow: (n) => {
            now = n
        },
        close: () => store.close(),
    }
}
const buy = (f) =>
    f.call('PlayerMallCreatePayOrder', {
        pay_shop_id: 202,
        pay_goods_id: 20201,
        buy_count: 1,
        product_id: 'lurukaps-offline:novice-0001:activity_gift_1',
        amount: '0',
    })
const claim = (f, day) => f.call('MallGetNovicePackReward', { u32: day })
const stock = (s, id) => s.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((n, r) => n + r.itemnum, 0)
const bonus = (f) => prepareNovicePack(tables, f.state(), f.now()).payload
test('18041 never grants paid rights for an unbought pack or a standalone gift item/stock counter', () => {
    const f = fixture()
    try {
        assert.equal(bonus(f).bought, false)
        let before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f, 1),
            (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.mall = { purchases: { 'pay:20201': { count: 1, period: 0 } } }
            s.player.sbag_infos.items.push({ itemid: 9000, itemnum: 1 })
        })
        before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f, 1),
            (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('18041 actual local paid order establishes purchased day1, syncs18040 before purchase reply, and grants current table rewards once', () => {
    const f = fixture()
    try {
        const packets = buy(f),
            sync = packets.findIndex((p) => p.id === 18040)
        assert(sync >= 0)
        assert.equal(packets[sync].data.status, 1)
        assert.equal(packets[sync].data.login_days, 1)
        // Request ID is obtained from the actual protocol mapping, never guessed.
        const actualAck = packets.findIndex((p) => p.id === protocol.byName.get('CSProtoPlayerMallCreatePayOrder').id)
        assert(actualAck >= 0 && sync < actualAck)
        const before = f.state(),
            out = claim(f, 1),
            reward = out.find((p) => p.id === 18041).data
        assert.deepEqual(
            reward.rewards.map((r) => [r.itemtype, r.itemid, r.itemnum]),
            [
                [3, 1520902, 1],
                [3, 400001, 5],
            ],
        )
        assert.equal(stock(f.state(), 1520902), stock(before, 1520902) + 1)
        assert.equal(stock(f.state(), 400001), stock(before, 400001) + 5)
        assert.deepEqual(bonus(f).already_fetched, [1])
        assert(out.findIndex((p) => p.id === 18040) < out.findIndex((p) => p.id === 18041))
        const after = f.state()
        assert.deepEqual(claim(f, 1).find((p) => p.id === 18041).data.rewards, [])
        assert.deepEqual(f.state(), after)
    } finally {
        f.close()
    }
})
test('18041 counts observed login dates, skips offline dates, rejects future days and grants typed skin/currency rewards', () => {
    const f = fixture()
    try {
        buy(f)
        const before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f, 2),
            (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.setNow(f.now() + 7 * 86400)
        f.call('EnterGame', { open_id: 'novice-pack' }, {})
        assert.equal(bonus(f).login_days, 2)
        const second = claim(f, 2).find((p) => p.id === 18041).data
        assert(second.rewards.some((r) => r.itemtype === 37 && r.itemid === 200001 && r.itemnum === 1))
        assert(second.rewards.some((r) => r.itemid === 1000005 && r.itemnum === 5))
        assert(f.state().petSkins.includes(200001))
        assert.throws(
            () => claim(f, 3),
            (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
        f.setNow(f.now() + 86400)
        const third = claim(f, 3).find((p) => p.id === 18041).data
        assert.deepEqual(
            third.rewards.map((r) => [r.itemtype, r.itemid, r.itemnum]),
            [
                [10, 1, 300],
                [10, 2, 30000],
            ],
        )
        assert.equal(bonus(f).login_days, 3)
        assert.deepEqual(bonus(f).already_fetched, [2, 3])
    } finally {
        f.close()
    }
})
test('18041 daily boundary uses configured refresh4 in server timezone8, not UTC midnight or elapsed24h', () => {
    const boundary = Date.UTC(2027, 0, 2, 20) / 1000,
        f = fixture(':memory:', boundary - 1)
    try {
        buy(f)
        assert.equal(bonus(f).login_days, 1)
        f.setNow(boundary)
        f.call('PlayerMallGetPayGoodsList', { pay_shop_id: 202 })
        assert.equal(bonus(f).login_days, 2)
        f.setNow(boundary + 3600)
        f.call('PlayerMallGetPayGoodsList', { pay_shop_id: 202 })
        assert.equal(bonus(f).login_days, 2)
    } finally {
        f.close()
    }
})
test('18041 paid but paused, unknown-day and malformed receipt states cannot add rewards or clear previous claims', () => {
    const f = fixture()
    try {
        buy(f)
        claim(f, 1)
        f.store.transact(f.session.id, 0, (s) => {
            s.mall.novicePack.status = 2
        })
        let before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f, 1),
            (e) => e.code === ErrorCode.MallGoodsDynamicCondInvalid,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.equal(bonus(f).bought, true)
        assert.equal(bonus(f).status, 2)
        assert.throws(
            () => claim(f, 99),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        f.store.transact(f.session.id, 0, (s) => {
            s.mall.novicePack.status = 1
            delete s.mall.purchases['pay:20201']
        })
        before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f, 1),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('18041 real reward/sync codec failures roll back inventory, entitlement dates and claimed flags', () => {
    const f = fixture()
    try {
        buy(f)
        for (const schema of [protocol.byId.get(18040).rsp, protocol.byId.get(18041).rsp]) {
            const before = f.store.load(f.session.id),
                encode = protocol.encode
            protocol.encode = function (type, data) {
                if (type === schema) throw Error('novice codec failure')
                return encode.call(this, type, data)
            }
            try {
                assert.throws(() => claim(f, 1), /novice codec failure/)
            } finally {
                protocol.encode = encode
            }
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        claim(f, 1)
        assert.deepEqual(bonus(f).already_fetched, [1])
    } finally {
        f.close()
    }
})
test('18041 genuine SQLite restart preserves login days, paid receipt and claimed rewards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-novice-pack-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture(file),
        store = f.store
    try {
        buy(f)
        claim(f, 1)
        const created = f.now()
        f.close()
        f = fixture(file, created + 5 * 86400)
        store = f.store
        assert.equal(bonus(f).login_days, 2)
        assert.deepEqual(bonus(f).already_fetched, [1])
        assert.deepEqual(claim(f, 1).find((p) => p.id === 18041).data.rewards, [])
        assert.equal(Object.keys(f.state().mall.localOrders).length, 1)
    } finally {
        store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-novice-pack-'))
        fs.rmSync(dir, { recursive: true })
    }
})

test('18041 migrating an older paid receipt counts only purchase/current observed login dates', () => {
    const f = fixture()
    try {
        buy(f)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.mall.novicePack
        })
        f.setNow(f.now() + 30 * 86400)
        f.call('EnterGame', { open_id: 'novice-pack' }, {})
        assert.equal(bonus(f).login_days, 2)
        assert.deepEqual(bonus(f).already_fetched, [])
        assert.equal(stock(f.state(), 1520902), 0)
    } finally {
        f.close()
    }
})
test('18041 a corrupt later reward cannot leave a first item granted or mark the day claimed', () => {
    const f = fixture(),
        row = tables.get('mall_shop_giftpack_login').find((r) => r.groupId === 101 && r.day === 1),
        original = row.reward
    try {
        buy(f)
        const before = f.store.load(f.session.id)
        row.reward = '3#400001#5|999#1#1'
        assert.throws(() => claim(f, 1))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        row.reward = original
        f.close()
    }
})

test('18041 request day and already_fetched row ID use separate namespaces', () => {
    const row = tables.get('mall_shop_giftpack_login').find((r) => r.groupId === 101 && r.day === 1),
        original = row.id,
        f = fixture()
    try {
        row.id = 101
        buy(f)
        claim(f, 1)
        assert.deepEqual(bonus(f).already_fetched, [101])
        assert.deepEqual(claim(f, 1).find((p) => p.id === 18041).data.rewards, [])
        assert.throws(
            () => claim(f, 101),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
    } finally {
        row.id = original
        f.close()
    }
})
