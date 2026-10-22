import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { staminaFixture } from './stamina-fixture.js'
import { spendCurrency } from '../src/inventory.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

test('login preserves configured above-cap initial stock and publishes native stamina timer and purchase attributes', () => {
    const f = staminaFixture('stamina-initial')
    try {
        const initial = Number(f.tables.get('game').find((r) => r.title === 'STAMINA_ACCOUNT_INITAIL').value)
        assert.equal(f.value(3), initial)
        assert(initial > f.tables.find('player_level', 1).stamina)
        assert.equal(f.value(200030), f.now())
        assert.equal(f.value(200029), 0)
        assert.equal(f.value(200031), 0)
        const entry = f.protocol.byName.get('CSProtoEnterGame')
        const login = f.protocol.decode(entry.rsp, f.entryPackets.find((p) => p.id === entry.id).payload)
        assert([3, 200029, 200030, 200031].every((id) => login.data.attr_infos.attrs.some((a) => a.attr_id === id)))
        f.advance(36000)
        f.call('StaminaSync')
        assert.equal(f.value(3), initial)
        assert.equal(f.value(200030), f.now() - 36000)
    } finally {
        f.store.close()
    }
})

test('9962 recovers one point per real interval, retains fractional progress, and stable bursts perform no SQLite writes', () => {
    const f = staminaFixture('stamina-recovery')
    try {
        const interval = Number(f.tables.get('game').find((r) => r.title === 'STAMINA_TIME').value)
        f.balance(100)
        const anchor = f.value(200030),
            writes = f.sql()
        f.advance(interval - 1)
        const packets = f.call('StaminaSync')
        assert.equal(f.value(3), 100)
        assert.deepEqual(
            packets.map((p) => p.id),
            [5008, 9962],
        )
        const attrs = f.protocol.decode('PlayerData', packets[0].payload).attr_infos.attrs
        assert(attrs.every((a) => [3, 200029, 200030, 200031].includes(a.attr_id)))
        assert.equal(attrs.find((a) => a.attr_id === 3).attr_val, '100')
        f.advance(2)
        f.call('StaminaSync')
        assert.equal(f.value(3), 101)
        assert.equal(f.value(200030), anchor + interval)
        const before = structuredClone(f.state()),
            pets = f.store.read(f.session.id, (s) => s.pets)
        const load = f.store.load,
            read = f.store.read
        let largeReads = 0
        f.store.load = function (...args) {
            largeReads++
            return load.apply(this, args)
        }
        f.store.read = function (...args) {
            largeReads++
            return read.apply(this, args)
        }
        try {
            for (let i = 0; i < 300; i++) f.call('StaminaSync')
        } finally {
            f.store.load = load
            f.store.read = read
        }
        assert.deepEqual(f.state(), before)
        assert.equal(
            f.store.read(f.session.id, (s) => s.pets),
            pets,
        )
        assert.equal(largeReads, 0)
        assert.equal(f.sql(), writes)
        f.advance(interval * 2 + 17)
        f.call('StaminaSync')
        assert.equal(f.value(3), 103)
        assert.equal(f.value(200030), anchor + interval * 3)
    } finally {
        f.store.close()
    }
})

test('full periods do not bank recovery; ordinary canonical spending starts a fresh clock and rewards pause it again', () => {
    const f = staminaFixture('stamina-transitions')
    try {
        const cap = f.tables.find('player_level', 1).stamina
        f.balance(cap)
        f.advance(36000)
        // Isolate the Game ordinary-request lifecycle around real shared
        // currency functions; this operator is test-only, not a new game action.
        const id = f.protocol.byName.get('CSProtoSetLanguage').id
        f.game.handlers.set(id, (c) => {
            spendCurrency(c.state, 3, 10)
            return {}
        })
        f.call('SetLanguage', { u32: 1 })
        assert.equal(f.value(3), cap - 10)
        assert.equal(f.value(200030), f.now())
        assert.equal(f.state().staminaRecovery.full, false)
        f.advance(359)
        f.call('StaminaSync')
        assert.equal(f.value(3), cap - 10)
        f.advance(1)
        f.call('StaminaSync')
        assert.equal(f.value(3), cap - 9)
        f.game.handlers.set(id, (c) => {
            grantRewards(c.tables, c.state, [{ itemtype: 10, itemid: 3, itemnum: 60 }])
            return {}
        })
        f.call('SetLanguage', { u32: 1 })
        const stock = f.value(3)
        assert(stock > cap)
        assert.equal(f.state().staminaRecovery.full, true)
        f.advance(36000)
        f.call('StaminaSync')
        assert.equal(f.value(3), stock)
    } finally {
        f.store.close()
    }
})

test('offline recovery stops at the level cap and a backward clock neither grants extra points nor reverses daily resets', () => {
    const f = staminaFixture('stamina-clock')
    try {
        const cap = f.tables.find('player_level', 1).stamina
        f.balance(cap - 2)
        f.advance(36000)
        f.call('StaminaSync')
        assert.equal(f.value(3), cap)
        f.balance(100)
        const anchor = f.value(200030)
        f.advance(-86400)
        f.call('StaminaSync')
        assert.equal(f.value(3), 100)
        assert.equal(f.value(200030), anchor)
    } finally {
        f.store.close()
    }
})

test('missing legacy timestamps start from now and malformed attributes fail without modifying the account', () => {
    const f = staminaFixture('stamina-legacy')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            delete s.staminaRecovery
            s.player.attr_infos.attrs = s.player.attr_infos.attrs.filter(
                (a) => ![200029, 200030, 200031].includes(a.attr_id),
            )
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '100'
        })
        f.call('StaminaSync')
        assert.equal(f.value(3), 100)
        assert.equal(f.value(200030), f.now())
        f.set(200030, 'broken')
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('StaminaSync'),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('real player-data or ACK encoding failures cannot leak deferred recovered points through a shared draft', () => {
    const f = staminaFixture('stamina-codec'),
        encode = f.protocol.encode
    try {
        f.balance(100)
        f.advance(360)
        for (const type of ['PlayerData', 'ProtoNullRsp']) {
            const shared = f.state(),
                before = structuredClone(shared),
                writes = f.sql()
            f.protocol.encode = function (name, ...args) {
                if (name === type || name === 'cs.' + type) throw Error('stamina encoding failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('StaminaSync'), /stamina encoding failed/)
            assert.deepEqual(shared, before)
            assert.deepEqual(f.state(), before)
            assert.equal(f.sql(), writes)
            f.protocol.encode = encode
        }
        f.call('StaminaSync')
        assert.equal(f.value(3), 101)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('partial recovery persists through actual SQLite close, reopen and login without resetting the remainder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-stamina-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite'),
            start = 1800000000
        f = staminaFixture('stamina-reopen', file, start)
        f.balance(100)
        f.advance(361)
        f.call('StaminaSync')
        assert.equal(f.value(3), 101)
        f.store.close()
        f = staminaFixture('stamina-reopen', file, start + 719)
        assert.equal(f.value(3), 101)
        f.advance(1)
        f.call('StaminaSync')
        assert.equal(f.value(3), 102)
        assert.equal(f.value(200030), start + 720)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-stamina-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('small snapshot cache stays warm without pending state and invalidates on durable, deferred and flushed updates', () => {
    const f = staminaFixture('stamina-cache')
    try {
        f.balance(100)
        f.call('StaminaSync')
        assert(!f.store.pending.has(f.session.id))
        const load = f.store.load,
            read = f.store.read,
            writes = f.sql()
        let largeReads = 0
        f.store.load = function (...args) {
            largeReads++
            return load.apply(this, args)
        }
        f.store.read = function (...args) {
            largeReads++
            return read.apply(this, args)
        }
        try {
            for (let i = 0; i < 300; i++) f.call('StaminaSync')
        } finally {
            f.store.load = load
            f.store.read = read
        }
        assert.equal(largeReads, 0)
        assert.equal(f.sql(), writes)
        assert.equal(f.session.staminaSyncCache.state.pets, undefined)
        assert.equal(f.session.staminaSyncCache.state.player.heros_info, undefined)
        const change = (n, options) =>
            f.store.transact(
                f.session.id,
                0,
                (s) => {
                    s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = String(n)
                },
                options,
            )
        change(90)
        f.call('StaminaSync')
        assert.equal(
            Number(f.session.staminaSyncCache.state.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val),
            90,
        )
        change(80, { defer: true })
        f.call('StaminaSync')
        const pendingToken = f.session.staminaSyncCache.token
        assert.equal(
            Number(f.session.staminaSyncCache.state.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val),
            80,
        )
        f.store.flushPending()
        f.call('StaminaSync')
        assert.notEqual(f.session.staminaSyncCache.token, pendingToken)
        change(70, { defer: true, persistWhen: () => true })
        f.call('StaminaSync')
        assert.equal(
            Number(f.session.staminaSyncCache.state.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val),
            70,
        )
        const token = f.session.staminaSyncCache.token
        assert.throws(
            () =>
                f.store.transact(f.session.id, 0, () => {
                    throw Error('aborted')
                }),
            /aborted/,
        )
        f.call('StaminaSync')
        assert.equal(f.session.staminaSyncCache.token, token)
    } finally {
        f.store.close()
    }
})
