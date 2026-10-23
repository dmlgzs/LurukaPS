import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { achievementFixture } from './achievement-fixture.js'
import { mergeHomeSettings } from '../src/home-settings.js'
import { ErrorCode } from '../src/error-codes.js'

const values = (f) => f.state().player.home_settings
const replay = (f, packets) => {
    for (const packet of packets) {
        const e = f.protocol.byId.get(packet.id)
        if (e?.rsp && f.protocol.type(e.rsp).fields.data?.resolvedType?.fields.home_settings)
            return f.protocol.decode(e.rsp, packet.payload).data.home_settings
    }
    assert.fail('PlayerData login snapshot missing')
}

test('6081 singleton deltas preserve existing keys and send no invented acknowledgement', () => {
    const f = achievementFixture('home-settings-deltas')
    try {
        assert.equal(f.protocol.byId.get(6081).rsp, undefined)
        for (const [key, val] of [
            ['first', '1'],
            ['second', '2'],
            ['first', '3'],
        ]) {
            const packets = f.call('SetHomeSetting', { entries: [{ key, val }] })
            assert.ok(packets.every((p) => p.id !== 6081))
        }
        assert.deepEqual(values(f), {
            entries: [
                { key: 'first', val: '3' },
                { key: 'second', val: '2' },
            ],
        })
        f.call('SetHomeSetting', { entries: [] })
        assert.equal(values(f).entries.length, 2)
    } finally {
        f.store.close()
    }
})

test('6081 uses proto2 empty defaults, preserves explicit empty, and keeps duplicate last value', () => {
    const f = achievementFixture('home-settings-defaults')
    try {
        const e = f.protocol.byId.get(6081)
        const payload = f.protocol.encode(e.req, {
            entries: [{ key: 'empty' }, {}, { key: 'same', val: 'old' }, { key: 'same', val: '' }],
        })
        assert.deepEqual(f.protocol.decode(e.req, payload).entries[0], { key: 'empty' })
        f.game.dispatch(f.session, { id: 6081, seq: 998, payload })
        assert.deepEqual(values(f), {
            entries: [
                { key: 'empty', val: '' },
                { key: '', val: '' },
                { key: 'same', val: '' },
            ],
        })
        const saved = structuredClone(values(f))
        f.call('SetHomeSetting', {})
        assert.deepEqual(values(f), saved)
    } finally {
        f.store.close()
    }
})

test('home settings retain large Unicode and literal base64 strings without decoding or guessed limits', () => {
    const f = achievementFixture('home-settings-strings')
    try {
        const key = '设置🌙'.repeat(1000),
            val = 'aGVsbG8=\u0000不是base64🌸'.repeat(10000)
        f.call('SetHomeSetting', {
            entries: [
                { key, val },
                { key: '__proto__', val: 'safe literal' },
            ],
        })
        assert.deepEqual(values(f), {
            entries: [
                { key, val },
                { key: '__proto__', val: 'safe literal' },
            ],
        })
        assert.equal({}.polluted, undefined)
    } finally {
        f.store.close()
    }
})

test('merge validates the entire request atomically and does not accept null or non-string values', () => {
    const saved = { entries: [{ key: 'keep', val: 'value' }] },
        before = structuredClone(saved)
    for (const request of [
        null,
        [],
        { entries: null },
        { entries: {} },
        { entries: [null] },
        { entries: [[]] },
        { entries: [{ key: 'good', val: 'changed' }, { key: null }] },
        { entries: [{ key: 'x', val: null }] },
        { entries: [{ key: 1, val: 'x' }] },
        { entries: [{ key: 'x', val: false }] },
    ]) {
        assert.throws(
            () => mergeHomeSettings(saved, request),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(saved, before)
    }
})

test('only undefined initializes legacy storage; damaged saved settings are not silently reset', () => {
    assert.deepEqual(mergeHomeSettings(undefined, {}), { entries: [] })
    assert.deepEqual(mergeHomeSettings({}, { entries: [{ key: 'x' }] }), { entries: [{ key: 'x', val: '' }] })
    assert.deepEqual(
        mergeHomeSettings(
            {
                entries: [
                    { key: 'x', val: 'first' },
                    { key: 'x', val: 'last' },
                ],
            },
            {},
        ),
        { entries: [{ key: 'x', val: 'last' }] },
    )
    for (const saved of [
        null,
        [],
        { entries: null },
        { entries: 1 },
        { entries: [null] },
        { entries: [{ key: 'x', val: null }] },
    ])
        assert.throws(
            () => mergeHomeSettings(saved, { entries: [{ key: 'new', val: 'value' }] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
})

test('6081 rejects damaged saved data through Game and rolls back earlier preparation', () => {
    const f = achievementFixture('home-settings-corrupt')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.home_settings = null
        })
        const before = f.state()
        assert.throws(
            () => f.call('SetHomeSetting', { entries: [{ key: 'new', val: 'value' }] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('a real post-handler notification codec failure rolls back the home setting delta', () => {
    const f = achievementFixture('home-settings-codec')
    try {
        // First post-login request has a pending 18006 battle-pass notification.
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        const type = f.protocol.byId.get(18006).rsp
        let reached = false
        f.protocol.encode = (name, value) => {
            if (name === type) {
                reached = true
                throw Error('home settings post-handler codec')
            }
            return encode(name, value)
        }
        assert.throws(
            () => f.call('SetHomeSetting', { entries: [{ key: 'rolled-back', val: 'yes' }] }),
            /post-handler codec/,
        )
        assert.ok(reached)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        assert.ok(f.call('SetHomeSetting', { entries: [{ key: 'retry', val: 'yes' }] }).every((p) => p.id !== 6081))
        assert.deepEqual(values(f), { entries: [{ key: 'retry', val: 'yes' }] })
    } finally {
        f.store.close()
    }
})

test('malformed wire data fails before home settings can mutate', () => {
    const f = achievementFixture('home-settings-wire')
    try {
        f.call('SetHomeSetting', { entries: [{ key: 'keep', val: 'yes' }] })
        const before = f.state()
        assert.throws(() => f.game.dispatch(f.session, { id: 6081, seq: 99, payload: Buffer.from('0aff', 'hex') }))
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('home settings persist across temporary SQLite reopen and replay in each account login snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-settings-b24-')),
        filename = path.join(dir, 'state.sqlite')
    let f
    try {
        f = achievementFixture('home-settings-account-a', filename)
        f.call('SetHomeSetting', { entries: [{ key: 'a', val: 'one' }] })
        f.call('SetHomeSetting', { entries: [{ key: 'b', val: 'two' }] })
        f.store.close()
        f = undefined
        f = achievementFixture('home-settings-account-b', filename)
        assert.deepEqual(replay(f, f.entryPackets), { entries: [] })
        f.call('SetHomeSetting', { entries: [{ key: 'a', val: 'other account' }] })
        f.store.close()
        f = undefined
        f = achievementFixture('home-settings-account-a', filename)
        assert.deepEqual(replay(f, f.entryPackets), {
            entries: [
                { key: 'a', val: 'one' },
                { key: 'b', val: 'two' },
            ],
        })
        f.call('SetHomeSetting', { entries: [{ key: 'b', val: '' }] })
        f.store.close()
        f = undefined
        f = achievementFixture('home-settings-account-b', filename)
        assert.deepEqual(replay(f, f.entryPackets), { entries: [{ key: 'a', val: 'other account' }] })
        f.store.close()
        f = undefined
        f = achievementFixture('home-settings-account-a', filename)
        assert.deepEqual(replay(f, f.entryPackets), {
            entries: [
                { key: 'a', val: 'one' },
                { key: 'b', val: '' },
            ],
        })
    } finally {
        f?.store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
