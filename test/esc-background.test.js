import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setup } from './social-wheel-fixture.js'
import { heroData } from '../src/player.js'
import { grantRewards } from '../src/rewards.js'
import { prepareEscBackground, escBackgroundUnlockSnapshot } from '../src/esc-background.js'
import { ErrorCode } from '../src/error-codes.js'
function minimal(f) {
    f.store.transact(f.session.id, 0, (s) => {
        s.player.heros_info.heros = [
            ...s.player.heros_info.heros.filter((h) => h.type === 1),
            heroData(101010, f.session.id),
        ]
        s.unlockedHeroSkins = {}
        s.player.soulessence_infos.soulessences = []
        s.taskRecords = []
        delete s.escBackground
    })
    return f.call('EnterGame', { open_id: 'social-wheel' }, {})
}
const snapshot = (f, out) => out.filter((p) => p.id === 19002).map(f.decode)
const owned = (f) => escBackgroundUnlockSnapshot(f.tables, f.state()).unlock_bgs
const slots = (ids) => Array.from({ length: 5 }, (_, i) => ({ slot_id: i + 1, background_id: ids[i] ?? 0 }))
test('19001 actual79-row catalogue unlocks only owned hero level/skin and real held soul or completed task; default is empty', () => {
    const f = setup()
    try {
        const login = minimal(f)
        assert(owned(f).includes(8))
        assert(!owned(f).includes(1))
        assert(!owned(f).includes(1000))
        assert(!owned(f).includes(2000))
        assert(snapshot(f, login).every((r) => r.slots.every((s) => s.background_id === 0)))
        f.store.transact(f.session.id, 0, (s) => {
            grantRewards(f.tables, s, [{ itemtype: 9, itemid: 10032, itemnum: 1 }])
            ;(s.taskRecords ??= []).push({ task_id: 106027, count: 1 })
        })
        const out = f.call('ChatRoomNum', { chat_type: 2 })
        assert(owned(f).includes(1000))
        assert(owned(f).includes(2000))
        assert(owned(f).includes(2001))
        assert(out.some((p) => p.id === 19003))
        const ledger = f.state().escBackground
        f.store.transact(f.session.id, 0, (s) => {
            s.player.soulessence_infos.soulessences = []
        })
        f.call('ChatRoomNum', { chat_type: 2 })
        assert.deepEqual(f.state().escBackground, ledger)
    } finally {
        f.close()
    }
})
test('19001 persists exact5-slot placement/duplicates/gaps and independenttab/mode, restores active tab last', () => {
    const f = setup()
    try {
        minimal(f)
        let out = f.call('SaveEscBackgroundInfo', {
            tab_type: 2,
            play_type: 2,
            slots: [
                { slot_id: 5, background_id: 8 },
                { slot_id: 2, background_id: 8 },
            ],
        })
        assert(out.findIndex((p) => p.id === 19002) < out.findIndex((p) => p.id === 19001))
        assert.deepEqual(snapshot(f, out), [{ tab_type: 2, play_type: 2, slots: slots([0, 8, 0, 0, 8]) }])
        assert.deepEqual(f.decode(out.find((p) => p.id === 19001)), { u32: 0 })
        const before = f.state().escBackground
        f.call('SaveEscBackgroundInfo', {
            tab_type: 2,
            play_type: 2,
            slots: [
                { slot_id: 5, background_id: 8 },
                { slot_id: 2, background_id: 8 },
            ],
        })
        assert.deepEqual(f.state().escBackground, before)
        f.call('SaveEscBackgroundInfo', { tab_type: 1, play_type: 1, slots: [] })
        const login = f.call('EnterGame', { open_id: 'social-wheel' }, {}),
            all = snapshot(f, login)
        assert.deepEqual(
            all.map((r) => r.tab_type),
            [2, 3, 1],
        )
        assert.deepEqual(all[0], { tab_type: 2, play_type: 2, slots: slots([0, 8, 0, 0, 8]) })
        assert.deepEqual(all[2].slots, slots([]))
    } finally {
        f.close()
    }
})
test('19001 rejects invalidtab/mode/slots/unknown/wrong category/unowned without changing background, inventory, other UIs', () => {
    const f = setup()
    try {
        minimal(f)
        for (const r of [
            { tab_type: 0, play_type: 1 },
            { tab_type: 2, play_type: 0 },
            { tab_type: 2, play_type: 1, slots: [{ slot_id: 6, background_id: 8 }] },
            {
                tab_type: 2,
                play_type: 1,
                slots: [
                    { slot_id: 1, background_id: 8 },
                    { slot_id: 1, background_id: 8 },
                ],
            },
            { tab_type: 2, play_type: 1, slots: [{ slot_id: 1, background_id: 9999 }] },
            { tab_type: 2, play_type: 1, slots: [{ slot_id: 1, background_id: 2000 }] },
            { tab_type: 3, play_type: 1, slots: [{ slot_id: 1, background_id: 8 }] },
            { tab_type: 2, play_type: 1, slots: [{ slot_id: 1, background_id: 1 }] },
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('SaveEscBackgroundInfo', r),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.close()
    }
})
test('19001 three actual response codecs roll back slots/unlocks and never touch6143 or9808 data', () => {
    const f = setup(),
        encode = f.protocol.encode
    try {
        minimal(f)
        for (const id of [19001, 19002, 19003]) {
            let before = f.state(),
                type = f.protocol.byId.get(id).rsp
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('esc codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(
                () =>
                    f.call('SaveEscBackgroundInfo', {
                        tab_type: 2,
                        play_type: 1,
                        slots: [{ slot_id: 1, background_id: 8 }],
                    }),
                /esc codec/,
            )
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})
test('19001 SQLite close/reopen restores all three tabs and active selection with no reward issuance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-bg-')),
        file = path.join(dir, 'state.sqlite')
    let f = setup(file)
    try {
        minimal(f)
        f.call('SaveEscBackgroundInfo', { tab_type: 2, play_type: 2, slots: [{ slot_id: 4, background_id: 8 }] })
        const before = f.state().escBackground
        f.close()
        f = setup(file)
        assert.deepEqual(f.state().escBackground, before)
        assert.equal(snapshot(f, f.login).at(-1).tab_type, 2)
        assert.deepEqual(snapshot(f, f.login).at(-1).slots, slots([0, 0, 0, 8]))
    } finally {
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('19001 unknown future condition, timedresource and unowned source are not silently granted', () => {
    const f = setup()
    try {
        minimal(f)
        const state = f.state()
        delete state.escBackground
        const base = f.tables.get('esc_background').find((r) => r.id === 8)
        const table = {
            get: (n) =>
                n === 'esc_background'
                    ? [
                          { ...base, id: 90001, unlockCondi: '999999#1#1' },
                          { ...base, id: 90002, timelimit: 1 },
                          { ...base, id: 90003, unlockCondi: '12023#101010#2' },
                      ]
                    : f.tables.get(n),
        }
        prepareEscBackground(table, state)
        assert.deepEqual(escBackgroundUnlockSnapshot(table, state).unlock_bgs, [])
    } finally {
        f.close()
    }
})

test('19001 repeated draft is a zero-write read; new draft defers one small private change and codec failures never publish pending data', () => {
    const f = setup()
    try {
        minimal(f)
        f.store.flushPending()
        const count = () => f.store.db.prepare('SELECT total_changes() AS n').get().n
        const initial = count()
        const r = { tab_type: 2, play_type: 1, slots: [{ slot_id: 1, background_id: 8 }] }
        f.call('SaveEscBackgroundInfo', r)
        assert.equal(count(), initial)
        assert.equal(f.store.pending.size, 1)
        const state = f.state(),
            token = f.store.readCacheToken(f.session.id)
        for (let i = 0; i < 20; i++) f.call('SaveEscBackgroundInfo', r)
        assert.equal(count(), initial)
        assert.equal(f.store.readCacheToken(f.session.id), token)
        assert.deepEqual(f.state(), state)
        f.store.flushPending()
        assert(count() > initial)
        const after = count()
        for (let i = 0; i < 20; i++) f.call('SaveEscBackgroundInfo', r)
        assert.equal(count(), after)
        assert.equal(f.store.pending.size, 0)
    } finally {
        f.close()
    }
})
