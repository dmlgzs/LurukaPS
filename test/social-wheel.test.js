import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setup } from './social-wheel-fixture.js'
import { socialWheelSnapshot, updateSocialWheel } from '../src/social-wheel.js'
import { ErrorCode } from '../src/error-codes.js'
const slots = (ids) => Array.from({ length: 8 }, (_, i) => ({ index: i + 1, id: ids[i] ?? 0 }))
test('6581 login uses current social_wheel entries and native1..8 empty slots, not chat emojis', () => {
    const f = setup()
    try {
        const s = f.sync(f.login)
        assert.deepEqual(
            s.infos.map((r) => r.id),
            Array.from({ length: 12 }, (_, i) => i + 1),
        )
        assert.deepEqual(s.social_wheel, slots([]))
        assert.equal(s.cur_emoticons_id, 0)
        assert.equal(f.state().chatEmoji, undefined)
    } finally {
        f.close()
    }
})
test('6581 saves exact slot order, duplicates are preserved, zero clears and del_all discards old nonempty sender snapshot', () => {
    const f = setup()
    try {
        const out = f.call('UpdateEmoticonsWheel', {
            wheel_data: [
                { index: 8, id: 12 },
                { index: 2, id: 1 },
                { index: 1, id: 1 },
            ],
        })
        assert(out.findIndex((p) => p.id === 6580) < out.findIndex((p) => p.id === 6581))
        assert.deepEqual(f.sync(out).social_wheel, slots([1, 1, 0, 0, 0, 0, 0, 12]))
        let before = f.state()
        f.call('UpdateEmoticonsWheel', {
            wheel_data: [
                { index: 8, id: 12 },
                { index: 2, id: 1 },
                { index: 1, id: 1 },
            ],
        })
        assert.deepEqual(f.state(), before)
        const clear = f.call('UpdateEmoticonsWheel', { wheel_data: slots([1, 1, 0, 0, 0, 0, 0, 12]), del_all: true })
        assert.deepEqual(f.sync(clear).social_wheel, slots([]))
        f.call('UpdateEmoticonsWheel', { wheel_data: [{ index: 3, id: 6 }] })
        assert.deepEqual(f.sync(f.call('UpdateEmoticonsWheel', {})).social_wheel, slots([]))
    } finally {
        f.close()
    }
})
test('6581 rejects invalid indices/data/config separately and rolls back without granting conditional or disabled entries', () => {
    const f = setup()
    try {
        for (const [data, code] of [
            [{ wheel_data: [{ index: 0, id: 1 }] }, ErrorCode.InvalidSocialWheelIndex],
            [{ wheel_data: [{ index: 9, id: 1 }] }, ErrorCode.InvalidSocialWheelIndex],
            [
                {
                    wheel_data: [
                        { index: 1, id: 1 },
                        { index: 1, id: 2 },
                    ],
                },
                ErrorCode.InvalidSocialWheelData,
            ],
            [{ wheel_data: [{ index: 1, id: 999 }] }, ErrorCode.SocialEmotionsConfError],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('UpdateEmoticonsWheel', data),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        for (const [field, value] of [
            ['lock_type', 2],
            ['unlock', '2004#5'],
            ['state', 0],
        ]) {
            const row = f.tables.find('social_wheel', 1),
                old = row[field]
            row[field] = value
            assert(!socialWheelSnapshot(f.tables, f.state()).infos.some((r) => r.id === 1))
            assert.throws(
                () => f.call('UpdateEmoticonsWheel', { wheel_data: [{ index: 1, id: 1 }] }),
                (e) => e.code === ErrorCode.InvalidSocialWheelData,
            )
            row[field] = old
        }
    } finally {
        f.close()
    }
})
test('6581 system174 follows106010/176 and not actor ownership; unavailable wheel rejects request', () => {
    const f = setup(':memory:', false)
    try {
        assert.deepEqual(f.sync(f.login).infos, [])
        assert.throws(
            () => f.call('UpdateEmoticonsWheel', { wheel_data: [{ index: 1, id: 1 }] }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        f.store.transact(f.session.id, 0, (s) => (s.taskRecords ??= []).push({ task_id: 106010, count: 1 }))
        const out = f.call('ChatRoomNum', { chat_type: 2 })
        assert(out.some((p) => p.id === 6580))
        assert.equal(f.sync(out).infos.length, 12)
    } finally {
        f.close()
    }
})
test('6581 codec failures on6580 and ACK roll back exact social state', () => {
    const f = setup(),
        encode = f.protocol.encode
    try {
        for (const id of [6580, 6581]) {
            const before = f.state(),
                type = f.protocol.byId.get(id).rsp
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('social codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('UpdateEmoticonsWheel', { wheel_data: [{ index: 5, id: 7 }] }), /social codec/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})
test('6581 SQLite reconnect retains all eight slots and does not replay an action', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-wheel-')),
        file = path.join(dir, 'state.sqlite')
    let f = setup(file)
    try {
        f.call('UpdateEmoticonsWheel', {
            wheel_data: [
                { index: 7, id: 10 },
                { index: 3, id: 6 },
            ],
        })
        f.close()
        f = setup(file)
        assert.deepEqual(f.sync(f.login).social_wheel, slots([0, 0, 6, 0, 0, 0, 10]))
        assert.equal(f.sync(f.login).cur_emoticons_id, 0)
    } finally {
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('6581 malformed saved wheel is a server data error', () => {
    const f = setup()
    try {
        const state = f.state()
        state.socialWheel.slots = [{ index: 1, id: 1 }]
        assert.throws(
            () => socialWheelSnapshot(f.tables, state),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})
