import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shortcutFixture, quickIds, nonQuickId } from './shortcuts-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { fixture as detectorFixture } from './world-detectors-fixture.js'

const snapshot = (packets) => packets.find((row) => row.id === 6568)?.data.item_infos
function unchanged(f, run, code) {
    const before = f.state(),
        writes = f.store.db.prepare('select total_changes() n').get().n
    assert.throws(run, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
    assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
}

test('6569 fills six client slots, replaces occupied placeholders and synchronizes a full sorted snapshot without granting anything', () => {
    const f = shortcutFixture()
    try {
        assert.deepEqual(snapshot(f.call('EnterGame', { open_id: 'shortcuts-a' }, {})), [])
        f.grant()
        const before = f.state(),
            writes = f.store.db.prepare('select total_changes() n').get().n
        assert.equal(quickIds.length, 228)
        for (let slot = 6; slot >= 1; slot--) {
            const result = f.add(quickIds[slot - 1], slot)
            assert.deepEqual(
                result.map((r) => r.id),
                [6568],
            )
            assert.equal(snapshot(result).length, 7 - slot)
        }
        assert.deepEqual(
            snapshot(f.add(quickIds[6], 3)).map((r) => r.item_id),
            [quickIds[0], quickIds[1], quickIds[6], quickIds[3], quickIds[4], quickIds[5]],
        )
        // Current add code has no cross-slot item uniqueness condition; preserve that behavior.
        assert.equal(snapshot(f.add(quickIds[0], 2)).filter((r) => r.item_id === quickIds[0]).length, 2)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(f.state().roulettes, before.roulettes)
        assert.deepEqual(f.store.load(f.other.id).state.itemShortcuts, undefined)
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
    } finally {
        f.store.close()
    }
})

test('occupied and empty exchanges, exact exchange replay and repeated removal cannot reverse or erase a replacement', () => {
    const f = shortcutFixture(),
        [a, b, c] = quickIds
    try {
        f.grant()
        f.add(a, 1)
        f.add(b, 2)
        const swapped = [
            { slot_id: 1, item_id: b },
            { slot_id: 2, item_id: a },
        ]
        assert.deepEqual(snapshot(f.swap(1, a, 2, b)), swapped)
        assert.deepEqual(snapshot(f.swap(1, a, 2, b)), swapped)
        assert.deepEqual(snapshot(f.swap(2, a, 6)), [
            { slot_id: 1, item_id: b },
            { slot_id: 6, item_id: a },
        ])
        assert.deepEqual(snapshot(f.swap(2, a, 6)), [
            { slot_id: 1, item_id: b },
            { slot_id: 6, item_id: a },
        ])
        assert.deepEqual(snapshot(f.remove(a, 6)), [{ slot_id: 1, item_id: b }])
        assert.deepEqual(snapshot(f.remove(a, 6)), [{ slot_id: 1, item_id: b }])
        f.add(c, 6)
        unchanged(f, () => f.remove(a, 6), ErrorCode.InvalidArgument)
        unchanged(f, () => f.swap(1, b, 6, a), ErrorCode.InvalidArgument)
    } finally {
        f.store.close()
    }
})

test('type, slot, source snapshot, eligibility and real unexpired ownership are distinct atomic validations', () => {
    const f = shortcutFixture(),
        [a, b] = quickIds
    try {
        f.grant([a, nonQuickId])
        unchanged(
            f,
            () => f.game.dispatch(f.session, { id: 6569, seq: 500, payload: Buffer.from([8, 2]) }),
            ErrorCode.ShortcutItemType,
        )
        unchanged(f, () => f.add(a, 7), ErrorCode.ShortcutItemSlotInVilid)
        unchanged(f, () => f.add(nonQuickId, 1), ErrorCode.ShortcutItemType)
        unchanged(f, () => f.add(b, 1), ErrorCode.ItemNotEnough)
        unchanged(f, () => f.call('ShortcutKeySet', { type: 1 }), ErrorCode.InvalidArgument)
        f.add(a, 1)
        unchanged(f, () => f.swap(1, a, 1, a), ErrorCode.ShortcutItemSlotRepeated)
        unchanged(f, () => f.swap(1, a, 2, b), ErrorCode.ItemNotEnough)
        f.edit((s) => {
            for (const row of s.player.sbag_infos.items) row.deadtime = f.now()
        })
        unchanged(f, () => f.add(a, 2), ErrorCode.ItemNotEnough)
        // Zero-count or expired references can always be removed, without requiring possession.
        assert.deepEqual(snapshot(f.remove(a, 1)), [])
    } finally {
        f.store.close()
    }
})

test('real detector consumption prunes every matching quick slot only when all owned stacks reach zero', () => {
    const f = detectorFixture()
    try {
        assert(f.usable.length > 0)
        const add = (slot) =>
            f.call('ShortcutKeySet', {
                type: 1,
                item: { src_item: { slot_id: 0, item_id: f.itemId }, tar_item: { slot_id: slot, item_id: 0 } },
            })
        add(1)
        add(4)
        for (let n = 0; n < 2; n++) {
            const packets = f.call('UseItem', { itemid: f.itemId, num: 1 })
            assert.equal(
                packets.some((p) => p.id === 6568),
                false,
            )
            assert.equal(f.state().itemShortcuts.length, 2)
        }
        const out = f.call('UseItem', { itemid: f.itemId, num: 1 })
        assert.deepEqual(snapshot(out), [])
        assert.deepEqual(f.state().itemShortcuts, [])
        assert.equal(f.state().player.sbag_infos.items.find((r) => r.itemid === f.itemId).itemnum, 0)
    } finally {
        f.close()
    }
})

test('actual 6568 encoding failure rolls back an in-memory edit, and shared ownership data is never mutated', () => {
    const f = shortcutFixture(),
        a = quickIds[0]
    try {
        f.grant()
        f.add(a, 1)
        const before = f.state(),
            token = f.store.readCacheToken(f.session.id),
            encode = f.protocol.encode
        f.protocol.encode = function (type, value) {
            if (type === 'cs.SCShortcutBaseSync') throw Error('shortcut codec failed')
            return encode.call(this, type, value)
        }
        assert.throws(() => f.add(quickIds[1], 1), /shortcut codec failed/)
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.readCacheToken(f.session.id), token)
        f.protocol.encode = encode
        f.add(quickIds[1], 1)
        assert.equal(f.state().itemShortcuts[0].item_id, quickIds[1])
    } finally {
        f.store.close()
    }
})

test('malformed stored slots are a configuration error, never silently rewritten into a partial layout', () => {
    const f = shortcutFixture()
    try {
        f.grant()
        f.edit((s) => {
            s.itemShortcuts = [
                { slot_id: 1, item_id: quickIds[0] },
                { slot_id: 1, item_id: quickIds[1] },
            ]
        })
        unchanged(f, () => f.add(quickIds[2], 2), ErrorCode.GameConfig)
    } finally {
        f.store.close()
    }
})

test('SQLite close/reopen and real login retain six-slot metadata, prune expired entries and leave roulette data unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-shortcuts-')),
        file = path.join(dir, 'test.sqlite')
    let f
    try {
        f = shortcutFixture(file)
        f.grant()
        f.add(quickIds[0], 1)
        f.add(quickIds[1], 6)
        f.edit((s) => {
            s.roulettes = { 3: { type: 3, guid: ['1000001', ...Array(8).fill('0')], pos: 1 } }
            s.player.sbag_infos.items.find((r) => r.itemid === quickIds[1]).deadtime = f.now() + 10
        })
        const roulette = f.state().roulettes
        f.store.close()
        f = shortcutFixture(file)
        f.advance(11)
        const packets = f.call('EnterGame', { open_id: 'shortcuts-a' }, {})
        assert.deepEqual(snapshot(packets), [{ slot_id: 1, item_id: quickIds[0] }])
        assert.deepEqual(f.state().itemShortcuts, [{ slot_id: 1, item_id: quickIds[0] }])
        assert.deepEqual(f.state().roulettes, roulette)
        assert.deepEqual(f.store.load(f.other.id).state.itemShortcuts, undefined)
    } finally {
        if (f?.store.db.open) f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-shortcuts-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
