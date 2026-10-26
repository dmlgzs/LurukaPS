import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { homeCurrencyFixture, homeCurrencyBalance, encodeCommand } from './home-currency-fixture.js'
import { readHomeCurrencyAcquisition, refundAcquisitionContext } from '../src/home-currency-acquisition.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { exchangeOrderPlan } from '../src/home-exchange-orders.js'
import { farmHarvestFixture } from './farm-harvest-fixture.js'

function offer(f) {
    if (!f.state().homeExchange?.board) f.call('CSExchangeOrderBoard')
    const slot = f.state().homeExchange.board.slots.find((row) => row.guid && !row.done)
    const row = f.tables.get('home_exchange_order').find((entry) => entry.orderID === slot.order_id)
    const amount = exchangeOrderPlan(f.tables, f.state(), row, f.clock())
        .rewards.filter((reward) => reward.itemtype === 10 && reward.itemid === 103)
        .reduce((n, reward) => n + BigInt(reward.itemnum), 0n)
    f.fundItems(row.orderNeedMaterials)
    return { slot, amount }
}
const finish = (f, item) => f.call('CSFinishOrder', { order_guid: item.slot.guid })
const total = (f) => readHomeCurrencyAcquisition(f.state())

test('actual6227 orders and6224 sale accumulate new normal103 once, independently of old balance, reports and optional src', () => {
    const f = homeCurrencyFixture('home-currency-normal-income')
    try {
        f.setOldBalance(90000000)
        f.edit((s) => {
            s.itemAcquisitionCounts = { ...s.itemAcquisitionCounts, '10:103': 90000000 }
        })
        assert.equal(total(f), 0n)
        let expected = 0n
        for (let i = 0; i < 2; i++) {
            const item = offer(f),
                before = homeCurrencyBalance(f.state())
            finish(f, item)
            expected += item.amount
            assert.equal(homeCurrencyBalance(f.state()) - before, item.amount)
            assert.equal(total(f), expected)
            finish(f, item)
            assert.equal(total(f), expected)
        }
        f.fundItems('3#400101#71')
        f.call('CSAddExchangeObj', { id: 10360011, num: 71, type: 3 })
        const before = homeCurrencyBalance(f.state())
        f.call('CSSettleImmediately')
        assert.equal(homeCurrencyBalance(f.state()) - before, 142n)
        expected += 142n
        assert.equal(total(f), expected)
        f.call('CSSettleImmediately')
        f.call('CSHistoryReport')
        assert.equal(total(f), expected)
        const item = offer(f),
            find = f.tables.find
        f.tables.find = function (name, id) {
            return name === 'reason_itemnum_change' ? undefined : find.call(this, name, id)
        }
        try {
            finish(f, item)
        } finally {
            f.tables.find = find
        }
        assert.equal(total(f), expected + item.amount)
    } finally {
        f.store.close()
    }
})

test('actual6038 two independent gift drops credit two103 leaves; normal farm experience recursively credits only new level rewards', () => {
    const f = homeCurrencyFixture('home-currency-gift-batch')
    try {
        f.fundItems('3#1520101#2')
        f.game.rng = (min, max) => (max === undefined ? (min === 430 ? 200 : 0) : min)
        f.call('BatchUseItem', { items: [{ itemid: 1520101, num: 2 }] })
        assert.equal(total(f), 2000n)
        assert.equal(homeCurrencyBalance(f.state()), 2000n)
        assert.equal(f.state().itemAcquisitionCounts?.['10:103'], undefined)
    } finally {
        f.store.close()
    }
    const farm = farmHarvestFixture('home-currency-level-recursion')
    try {
        farm.grow(1)
        const level = farm.tables.find('home_level', 1)
        farm.edit((state) => {
            Object.assign(state.home, {
                level: 1,
                exp: level.exp - 1,
                experienceVersion: 1,
                experienceTotal: String(level.exp - 1),
                levelRewardedThrough: 1,
            })
            let attr = state.player.attr_infos.attrs.find((r) => r.attr_id === 1003)
            if (!attr) state.player.attr_infos.attrs.push((attr = { attr_id: 1003, attr_val: '0' }))
            attr.attr_val = String(level.exp - 1)
        })
        const before = homeCurrencyBalance(farm.state()),
            old = readHomeCurrencyAcquisition(farm.state())
        farm.harvest()
        assert(farm.state().home.level > 1)
        const gained = homeCurrencyBalance(farm.state()) - before
        assert(gained > 0n)
        assert.equal(readHomeCurrencyAcquisition(farm.state()) - old, gained)
    } finally {
        farm.close()
    }
})

test('actual GM direct, batch, chat and recursive home-level rewards are excluded, then a new normal order counts including its benefit', () => {
    const f = homeCurrencyFixture('home-currency-admin-recursion')
    try {
        f.gm('give 10 103 7')
        const exp = f.tables.find('home_level', 1).exp + 1
        f.call('GMCommands', {
            cmds: [encodeCommand('give 10 103 2'), encodeCommand('give 10 1003 ' + exp), encodeCommand('gold 1')],
        })
        f.call('AddChat', {
            target: { chat_type: 2, tid: '1' },
            type: 0,
            msg: Buffer.from('/give 10 103 5').toString('base64'),
        })
        assert(f.state().home.level > 1)
        assert(homeCurrencyBalance(f.state()) > 14n)
        assert.equal(total(f), 0n)
        f.gm('monthcard 1')
        assert.equal(total(f), 0n)
        const item = offer(f),
            before = homeCurrencyBalance(f.state())
        finish(f, item)
        assert.equal(homeCurrencyBalance(f.state()) - before, item.amount)
        assert.equal(total(f), item.amount)
        f.gm('giveall')
        assert.equal(total(f), item.amount)
        const after = f.state()
        assert.throws(() =>
            f.call('GMCommands', { cmds: [encodeCommand('give 10 103 9'), encodeCommand('invalid-operation')] }),
        )
        assert.deepEqual(f.state(), after)
    } finally {
        f.store.close()
    }
})

test('actual6227 codec and SQL failures preserve pending counter/attrs/disk; retry and receipt replay add only one income', () => {
    const f = homeCurrencyFixture('home-currency-source-rollback')
    try {
        const first = offer(f)
        finish(f, first)
        const second = offer(f)
        f.store.transact(f.session().id, 0, () => {}, { defer: true })
        const pending = f.store.pending.get(f.session().id),
            record = pending.state.homeCurrencyAcquisition
        const before = f.state(),
            disk = f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session().id).state
        const packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoSyncPlayerData') throw Error('currency-source-codec')
            return packet.call(this, name, ...args)
        }
        try {
            assert.throws(() => finish(f, second), /currency-source-codec/)
        } finally {
            f.game.packet = packet
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session().id), pending)
        assert.equal(pending.state.homeCurrencyAcquisition, record)
        f.store.db.exec(
            "CREATE TEMP TRIGGER home_currency_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'currency-source-sql'); END",
        )
        try {
            assert.throws(() => finish(f, second), /currency-source-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER home_currency_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session().id), pending)
        assert.equal(pending.state.homeCurrencyAcquisition, record)
        assert.equal(f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session().id).state, disk)
        finish(f, second)
        assert.equal(total(f), first.amount + second.amount)
        finish(f, second)
        assert.equal(total(f), first.amount + second.amount)
    } finally {
        f.store.close()
    }
})

test('normal source persists by account, keeps unknown future counters without withholding money, and diagnostic failure is nonblocking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-currency-source-'))
    const filename = path.join(dir, 'test.sqlite')
    let f = homeCurrencyFixture('home-currency-persistent', { filename })
    try {
        const item = offer(f)
        finish(f, item)
        f.store.close()
        f = homeCurrencyFixture('home-currency-persistent', { filename })
        assert.equal(total(f), item.amount)
        finish(f, item)
        assert.equal(total(f), item.amount)
        const other = homeCurrencyFixture('home-currency-other', { filename })
        try {
            assert.equal(total(other), 0n)
        } finally {
            other.store.close()
        }
        f.edit((state) => {
            state.homeCurrencyAcquisition = { version: 8, total: '99999999' }
        })
        const next = offer(f),
            before = homeCurrencyBalance(f.state()),
            warn = console.warn
        console.warn = () => {
            throw Error('diagnostic-unavailable')
        }
        try {
            finish(f, next)
        } finally {
            console.warn = warn
        }
        assert.equal(homeCurrencyBalance(f.state()) - before, next.amount)
        assert.deepEqual(f.state().homeCurrencyAcquisition, { version: 8, total: '99999999' })
        assert.equal(total(f), 0n)
        f.edit((state) => {
            delete state.homeCurrencyAcquisition
            grantRewards(
                f.tables,
                state,
                [{ itemtype: 10, itemid: 103, itemnum: 3 }],
                0,
                refundAcquisitionContext({ personalFavor: { recipients: [] } }),
            )
        })
        assert.equal(total(f), 0n)
    } finally {
        f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('home-currency-source-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
