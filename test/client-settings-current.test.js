import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { achievementFixture } from './achievement-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { mergeClientSettings } from '../src/client-settings.js'
const settings = (f) => f.state().player.settings
function playerData(f, packets) {
    const p = packets.find((p) => p.id === 5001)
    assert(p)
    return f.protocol.decode(f.protocol.byId.get(5001).rsp, p.payload).data
}
function customInt(data, key, fallback = 0) {
    // Current SyncServerSettings clears the int dictionary, then set_Item for
    // every parseable key; GetCustomValueInt TryParses the stored string.
    const cache = new Map()
    for (const row of data.settings?.entries ?? []) {
        if (/^[+-]?\d+$/.test(row.key.trim()) && Number(row.key) >= -2147483648 && Number(row.key) <= 2147483647)
            cache.set(Number(row.key), row.val)
    }
    const value = cache.get(key)
    return typeof value === 'string' &&
        /^[+-]?\d+$/.test(value.trim()) &&
        Number(value) >= -2147483648 &&
        Number(value) <= 2147483647
        ? Number(value)
        : fallback
}
function relogin(f, open_id) {
    const session = {},
        entry = f.protocol.byId.get(5001)
    const packets = f.game.dispatch(session, { id: 5001, seq: 1, payload: f.protocol.encode(entry.req, { open_id }) })
    for (const key of Object.keys(f.session)) delete f.session[key]
    Object.assign(f.session, session)
    return packets
}
test('current11831 actual100001 singleton is one-way, preserves11830 complete-save entries and resumes through real PlayerData.settings', () => {
    const f = achievementFixture('settings-current-actual')
    try {
        assert.equal(f.protocol.byId.get(11831).req, 'cs.GameClientSetting')
        assert.equal(f.protocol.byId.get(11831).rsp, undefined)
        assert.equal(customInt(playerData(f, f.entryPackets), 100001), 0)
        f.call('SetSetting', { entries: [{ key: '100002', val: '2' }] })
        const packets = f.call('UpdateSetting', { entries: [{ key: '100001', val: '1' }] })
        assert(
            packets.every((p) => p.id !== 11831),
            'do not invent an ACK for a one-way sender',
        )
        assert.deepEqual(settings(f), {
            entries: [
                { key: '100002', val: '2' },
                { key: '100001', val: '1' },
            ],
        })
        const login = relogin(f, 'settings-current-actual')
        const data = playerData(f, login)
        assert.equal(customInt(data, 100001), 1)
        assert.equal(customInt(data, 100002), 2)
        f.call('UpdateSetting', { entries: [{ key: '100001', val: '' }] })
        assert.equal(settings(f).entries.find((r) => r.key === '100001').val, '')
        assert.equal(customInt(playerData(f, relogin(f, 'settings-current-actual')), 100001), 0)
    } finally {
        f.store.close()
    }
})
test('current dictionary last-wins/default strings preserve opaque values and numeric-key identities without base64 decoding', () => {
    const previous = {
        entries: [
            { key: '100001', val: '0' },
            { key: '+0100001', val: 'old' },
            { key: 'opaqueLegacy', val: '保留' },
        ],
    }
    const result = mergeClientSettings(previous, {
        entries: [{ key: '100001', val: 'one' }, { key: '100001', val: '1' }, { key: '100002' }, {}],
    })
    assert.deepEqual(result, {
        entries: [
            { key: '100001', val: '1' },
            { key: 'opaqueLegacy', val: '保留' },
            { key: '100002', val: '' },
            { key: '', val: '' },
        ],
    })
    assert.deepEqual(previous.entries[1], { key: '+0100001', val: 'old' })
    const text = 'aGVsbG8=\u0000原样🙂'.repeat(2000)
    assert.equal(mergeClientSettings(undefined, { entries: [{ key: '100003', val: text }] }).entries[0].val, text)
    assert.deepEqual(mergeClientSettings(result, {}), result)
    for (const saved of [null, [], { entries: null }, { entries: [null] }, { entries: [{ key: 1, val: '1' }] }])
        assert.throws(() => mergeClientSettings(saved, {}), { code: ErrorCode.GameConfig })
    for (const request of [
        null,
        [],
        { entries: null },
        { entries: [null] },
        { entries: [{ key: '100001', val: 1 }] },
        { entries: [{ key: 'bad\ud800', val: '1' }] },
    ])
        assert.throws(() => mergeClientSettings({ entries: [] }, request), { code: ErrorCode.InvalidArgument })
})
test('two real accounts stay isolated across private SQLite close/reopen and full current login consumer', () => {
    const first = achievementFixture('settings-file-a')
    const work = path.resolve(first.cfg.base, '../work/obt-runtime-errors-20261126/client-settings-current-agent')
    first.store.close()
    fs.mkdirSync(work, { recursive: true })
    const dir = fs.mkdtempSync(path.join(work, 'private-db-')),
        file = path.join(dir, 'state.sqlite')
    let f = achievementFixture('settings-file-a', file)
    f.call('UpdateSetting', { entries: [{ key: '100001', val: '1' }] })
    f.store.close()
    f = achievementFixture('settings-file-b', file)
    try {
        assert.equal(customInt(playerData(f, f.entryPackets), 100001), 0)
        f.call('UpdateSetting', {
            entries: [
                { key: '100001', val: '0' },
                { key: '100002', val: '5' },
            ],
        })
    } finally {
        f.store.close()
    }
    f = achievementFixture('settings-file-a', file)
    try {
        assert.equal(customInt(playerData(f, f.entryPackets), 100001), 1)
        assert.equal(customInt(playerData(f, f.entryPackets), 100002), 0)
    } finally {
        f.store.close()
    }
})
test('one-way11831 rolls back on a real post-handler18006 codec failure, SQL abort and malformed wire', () => {
    const f = achievementFixture('settings-current-rollback')
    try {
        const snapshot = () => f.store.load(f.session.id),
            before = snapshot(),
            encode = f.protocol.encode
        const type = f.protocol.byId.get(18006).rsp
        let reached = false
        f.protocol.encode = function (name, value) {
            if (name === type) {
                reached = true
                throw Error('settings-post-handler-codec')
            }
            return encode.call(this, name, value)
        }
        try {
            assert.throws(
                () => f.call('UpdateSetting', { entries: [{ key: '100001', val: '1' }] }),
                /settings-post-handler-codec/,
            )
        } finally {
            f.protocol.encode = encode
        }
        assert(reached, 'actual existing Game notification must exercise the rollback')
        assert.deepEqual(snapshot(), before)
        f.store.db.exec(
            "CREATE TRIGGER settings_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'settings-sql'); END",
        )
        try {
            assert.throws(() => f.call('UpdateSetting', { entries: [{ key: '100001', val: '1' }] }), /settings-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER settings_abort')
        }
        assert.deepEqual(snapshot(), before)
        f.call('UpdateSetting', { entries: [{ key: '100001', val: '1' }] })
        const stable = snapshot()
        assert.throws(() => f.game.dispatch(f.session, { id: 11831, seq: 998, payload: Buffer.from('0aff', 'hex') }))
        assert.deepEqual(snapshot(), stable)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.settings = null
        })
        const damaged = snapshot()
        assert.throws(() => f.call('UpdateSetting', { entries: [{ key: '100001', val: '0' }] }), {
            code: ErrorCode.GameConfig,
        })
        assert.deepEqual(snapshot(), damaged)
    } finally {
        f.store.close()
    }
})
