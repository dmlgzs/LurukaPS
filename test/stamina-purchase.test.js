import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { staminaFixture } from './stamina-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

function wallet(f, amount) {
    f.store.transact(f.session.id, 0, (s) => {
        s.player.basic_info.diamond = amount
        s.player.attr_infos.attrs.find((a) => a.attr_id === 1).attr_val = String(amount)
    })
}

test('9960 buys all six configured tiers with shared wallet/resource delivery and native empty ACK', () => {
    const f = staminaFixture('stamina-buy')
    try {
        f.balance(100)
        wallet(f, 2000)
        const rows = f.tables.get('stamina').sort((a, b) => a.id - b.id)
        let total = 0,
            gain = 0
        for (const row of rows) {
            const cost = Number(row.price.split('|')[2])
            const packets = f.call('BuyStamina')
            total += cost
            gain += row.stamina
            assert.equal(f.state().player.basic_info.diamond, 2000 - total)
            assert.equal(f.value(1), 2000 - total)
            assert.equal(f.value(3), 100 + gain)
            assert.equal(f.value(200031), row.id)
            assert.equal(f.value(200029), f.now())
            const ack = packets.findIndex((p) => p.id === 9960),
                sync = packets.findIndex((p) => p.id === 5008)
            assert(sync >= 0 && sync < ack)
            assert.deepEqual(f.protocol.decode('ProtoNullRsp', packets[ack].payload), {})
        }
        assert.equal(total, 540)
        assert.equal(gain, 360)
        assert.equal(f.state().noviceCounters.staminaSpent, 0, 'gaining stamina is not spending it')
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('BuyStamina'),
            (e) => e.code === ErrorCode.BuyStamina,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('native strict capacity permits exact fit, rejects overflow, and never trims existing configured surplus', () => {
    const f = staminaFixture('stamina-buy-cap')
    try {
        wallet(f, 2000)
        f.balance(940)
        f.call('BuyStamina')
        assert.equal(f.value(3), 1000)
        f.balance(941)
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('BuyStamina'),
            (e) => e.code === ErrorCode.StaminaIsMax,
        )
        assert.deepEqual(f.state(), before)
        f.balance(10000)
        assert.throws(
            () => f.call('BuyStamina'),
            (e) => e.code === ErrorCode.StaminaIsMax,
        )
        assert.equal(f.value(3), 10000)
    } finally {
        f.store.close()
    }
})

test('daily purchase budget resets at the configured game day boundary and never resets backward', () => {
    const f = staminaFixture('stamina-buy-day')
    try {
        wallet(f, 2000)
        f.balance(100)
        for (let i = 0; i < 6; i++) f.call('BuyStamina')
        const hour = Number(f.tables.get('game').find((r) => r.title === 'DAILY_REFRESH_TIME').value)
        const shift = (8 - hour) * 3600,
            boundary = (Math.floor((f.now() + shift) / 86400) + 1) * 86400 - shift
        f.time(boundary - 1)
        f.call('StaminaSync')
        assert.equal(f.value(200031), 6)
        f.time(boundary)
        f.call('StaminaSync')
        assert.equal(f.value(200031), 0)
        const diamond = f.value(1)
        f.call('BuyStamina')
        assert.equal(f.value(200031), 1)
        assert.equal(f.value(1), diamond - 60)
        f.time(boundary - 2)
        f.call('StaminaSync')
        assert.equal(f.value(200031), 1)
        f.time(boundary + 1)
        f.call('StaminaSync')
        assert.equal(f.value(200031), 1)
    } finally {
        f.store.close()
    }
})

test('insufficient money, closed purchase, malformed prices and supported debt guard cannot charge the account', () => {
    for (const mode of ['money', 'closed', 'price', 'debt']) {
        const f = staminaFixture('stamina-buy-invalid-' + mode)
        try {
            f.balance(100)
            let code = ErrorCode.GameConfig
            if (mode === 'money') {
                wallet(f, 59)
                code = ErrorCode.ItemNotEnough
            }
            if (mode === 'closed') {
                f.tables.get('game').find((r) => r.title === 'STAMINA_SWITCH').value = '0'
                code = ErrorCode.BuyStaminaClose
            }
            if (mode === 'price') f.tables.get('stamina')[0].price = '10|1|0'
            if (mode === 'debt') {
                f.store.transact(f.session.id, 0, (s) => {
                    s.mallDebtPack = { debt_list: [{ item_type: 10, item_id: 901, item_debt: '1' }] }
                })
                code = ErrorCode.FunctionClosed
            }
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('BuyStamina'),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        } finally {
            f.store.close()
        }
    }
})

test('purchases below the natural cap retain the recovery remainder and buying above it pauses without hidden gains', () => {
    const f = staminaFixture('stamina-buy-clock')
    try {
        wallet(f, 2000)
        f.balance(100)
        const anchor = f.value(200030)
        f.advance(359)
        f.call('BuyStamina')
        assert.equal(f.value(3), 160)
        assert.equal(f.value(200030), anchor)
        f.advance(1)
        f.call('StaminaSync')
        assert.equal(f.value(3), 161)
        for (let i = 0; i < 3; i++) f.call('BuyStamina')
        assert(f.value(3) > 300)
        const stock = f.value(3)
        f.advance(3600)
        f.call('StaminaSync')
        assert.equal(f.value(3), stock)
    } finally {
        f.store.close()
    }
})

test('actual wallet sync or purchase ACK encoding failures roll back cost, gain, count, timestamp and read cache', () => {
    const f = staminaFixture('stamina-buy-codec'),
        encode = f.protocol.encode
    try {
        wallet(f, 2000)
        f.balance(100)
        f.call('StaminaSync')
        for (const type of ['PlayerData', 'ProtoNullRsp']) {
            const before = structuredClone(f.state()),
                token = f.store.readCacheToken(f.session.id)
            f.protocol.encode = function (name, ...args) {
                if (name === type || name === 'cs.' + type) throw Error('purchase encoding failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('BuyStamina'), /purchase encoding failed/)
            assert.deepEqual(f.state(), before)
            assert.equal(f.store.readCacheToken(f.session.id), token)
            f.protocol.encode = encode
        }
        f.call('BuyStamina')
        f.call('StaminaSync')
        assert.equal(f.value(3), 160)
        assert.equal(f.value(200031), 1)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('purchase state and clock survive real SQLite reopen and login and the next request uses the next price row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-stamina-buy-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite'),
            start = 1800000000
        f = staminaFixture('stamina-buy-reopen', file, start)
        wallet(f, 2000)
        f.balance(100)
        for (let i = 0; i < 3; i++) f.call('BuyStamina')
        const diamond = f.value(1)
        f.store.close()
        f = staminaFixture('stamina-buy-reopen', file, start + 1)
        assert.equal(f.value(200031), 3)
        assert.equal(f.value(3), 280)
        assert.equal(f.value(200029), start)
        f.call('BuyStamina')
        assert.equal(f.value(1), diamond - 120)
        assert.equal(f.value(3), 340)
        assert.equal(f.value(200031), 4)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-stamina-buy-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
