import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { compileItemShortcutCompatibility } from '../src/item-shortcut-compatibility.js'
import { pruneItemShortcuts, shortcutSnapshot } from '../src/shortcuts.js'
import policy from '../configs/item-shortcut-compatibility.json' with { type: 'json' }
import { fixture as detectorFixture } from './world-detectors-fixture.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const currentItems = tables.get('common_item'),
    quick = currentItems.filter((item) => item.isQuickBar === 1),
    retired = policy.retiredIds
function fixture(t, name, ids = retired.slice(0, 6), { login = true, raw = true } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-retired-shortcut-')),
        filename = path.join(directory, 'synthetic.sqlite')
    let store,
        game,
        session = {},
        now = 1800000000,
        sequence = 1
    const state = seedPlayer(tables, 1, name)
    delete state.starterProfile
    delete state.normalStarterAvatar
    state.characterCustomized = true
    state.player.basic_info.name = Buffer.from('历史快捷').toString('base64')
    state.player.basic_info.lock_system = []
    state.player.sbag_infos.items = ids.map((id, index) => ({
        itemtype: 3,
        itemid: id,
        itemnum: 1,
        guid: String(index + 1),
        deadtime: index === 0 ? now + 1 : 0,
    }))
    state.nextItemGuid = String(ids.length + 1)
    state.itemShortcuts = raw ? ids.map((id, index) => ({ slot_id: index + 1, item_id: id })) : []
    const oldRows = structuredClone(state.itemShortcuts),
        oldBag = structuredClone(state.player.sbag_infos)
    store = new Store(filename)
    const account = store.login(name, () => state)
    game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    t.after(() => {
        store?.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const current = () => store.load(account.id).state
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: sequence++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    const enter = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    const snapshot = (packets) =>
        packets
            .filter((packet) => packet.id === 6568)
            .map((packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload).item_infos)
    const edit = (fn) => store.transact(account.id, 0, fn)
    const grant = (id, count = 2) =>
        call('GMCommand', { command: Buffer.from(`give 3 ${id} ${count}`).toString('base64') })
    const add = (id, slot) =>
        call('ShortcutKeySet', {
            type: 1,
            item: { src_item: { slot_id: 0, item_id: id }, tar_item: { slot_id: slot, item_id: 0 } },
        })
    const clear = (id, slot) => call('ShortcutKeySet', { type: 1, item: { src_item: { slot_id: slot, item_id: id } } })
    const swap = (from, id, to, target = 0) =>
        call('ShortcutKeySet', {
            type: 1,
            item: { src_item: { slot_id: from, item_id: id }, tar_item: { slot_id: to, item_id: target } },
        })
    const reopen = () => {
        store.close()
        store = new Store(filename)
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
        return enter()
    }
    const initial = login ? enter() : []
    return {
        get store() {
            return store
        },
        get game() {
            return game
        },
        get session() {
            return session
        },
        account,
        current,
        call,
        enter,
        snapshot,
        edit,
        grant,
        add,
        clear,
        swap,
        reopen,
        oldRows,
        oldBag,
        initial,
        advance: (seconds) => (now += seconds),
        now: () => now,
    }
}
const unchanged = (f, fn, code) => {
    const before = f.store.load(f.account.id),
        token = f.store.readCacheToken(f.account.id)
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.store.load(f.account.id), before)
    assert.equal(f.store.readCacheToken(f.account.id), token)
}
const validWire = (rows) => {
    assert(rows.every((row) => currentItems.some((item) => item.id === row.item_id && item.isQuickBar === 1)))
    assert.equal(new Set(rows.map((row) => row.slot_id)).size, rows.length)
}

test('complete historical quickbar difference and current-first eligibility remain strict without restoring slots from metadata', () => {
    const expected = policy.source.historicalQuickIds.filter((id) => !currentItems.some((item) => item.id === id))
    assert.deepEqual(retired, expected)
    assert.equal(retired.length, 12)
    assert.equal(policy.source.historicalQuickIds.length, 228)
    const compat = compileItemShortcutCompatibility(currentItems),
        id = retired[0]
    assert(compat.retired(id))
    const restored = compileItemShortcutCompatibility([...currentItems, { id, isQuickBar: 0 }])
    assert.equal(restored.retired(id), false, 'present current definition wins even if it is not quickbar eligible')
    const changed = compileItemShortcutCompatibility([...currentItems, { id: 4000000000, isQuickBar: 1 }])
    assert.equal(changed.retired(4000000000), false)
    assert.throws(
        () => changed.retired(id),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const bad = structuredClone(policy)
    bad.retiredIds.pop()
    assert.throws(
        () => compileItemShortcutCompatibility(currentItems, bad).retired(id),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const saved = { itemShortcuts: [{ slot_id: 1, item_id: id }] }
    compat.remember(saved, saved.itemShortcuts)
    const before = structuredClone(saved.itemShortcutCompatibility)
    assert.equal(compat.remember(saved, saved.itemShortcuts), false)
    assert.deepEqual(saved.itemShortcutCompatibility, before)
})

test('all12 historical identities survive cold login and expired stock as raw layout, while current6568 never exposes missing definitions', (t) => {
    for (const offset of [0, 6]) {
        const f = fixture(t, 'retired-shortcuts-cold-' + offset, retired.slice(offset, offset + 6))
        assert(f.snapshot(f.initial).length > 0)
        for (const rows of f.snapshot(f.initial)) {
            assert.deepEqual(rows, [])
            validWire(rows)
        }
        assert.deepEqual(f.current().itemShortcuts, f.oldRows)
        assert.deepEqual(
            f.current().itemShortcutCompatibility.entries.map((entry) => entry.original),
            f.oldRows,
        )
        assert.deepEqual(f.current().player.sbag_infos, f.oldBag)
        const archive = structuredClone(f.current().itemShortcutCompatibility),
            draft = structuredClone(f.current())
        assert.equal(pruneItemShortcuts(draft, f.now()), false)
        assert.deepEqual(draft.itemShortcutCompatibility, archive)
        f.advance(10)
        for (const rows of f.snapshot(f.enter())) assert.deepEqual(rows, [])
        assert.deepEqual(f.current().itemShortcuts, f.oldRows)
        assert.deepEqual(f.current().itemShortcutCompatibility, archive)
        f.game.tick(f.account.id, f.session)
        assert.deepEqual(f.current().itemShortcutCompatibility, archive)
        for (const rows of f.snapshot(f.reopen())) assert.deepEqual(rows, [])
        assert.deepEqual(f.current().itemShortcuts, f.oldRows)
        assert.deepEqual(f.current().itemShortcutCompatibility, archive)
        assert.deepEqual(f.current().player.sbag_infos, f.oldBag)
        unchanged(f, () => f.add(retired[offset], 1), ErrorCode.ShortcutItemType)
        unchanged(f, () => f.call('UseItem', { itemid: retired[offset], num: 1 }), ErrorCode.ItemCannotFound)
    }
    const f = fixture(t, 'retired-no-invented-slots', retired.slice(0, 6), { raw: false })
    assert.deepEqual(f.current().itemShortcuts, [])
    assert.equal(f.current().itemShortcutCompatibility, undefined)
})

test('real6569 replacement/clear and public-empty-target exchange preserve history, known slots and duplicate/repeated constraints', (t) => {
    const f = fixture(t, 'retired-shortcuts-edits', retired.slice(0, 3)),
        a = quick[0].id,
        b = quick[1].id
    f.grant(a)
    f.grant(b)
    const archive = structuredClone(f.current().itemShortcutCompatibility)
    let rows = f.snapshot(f.add(a, 1)).at(-1)
    assert.deepEqual(rows, [{ slot_id: 1, item_id: a }])
    validWire(rows)
    unchanged(f, () => f.clear(retired[0], 1), ErrorCode.InvalidArgument)
    // Actual native6569 add from bag uses sourceSlot0/targetItem0 even for
    // replacement. The historical raw slot is hidden, so target public view is0.
    f.add(a, 2)
    rows = f.snapshot(f.swap(2, a, 3)).at(-1)
    assert.deepEqual(rows, [
        { slot_id: 1, item_id: a },
        { slot_id: 3, item_id: a },
    ])
    validWire(rows)
    assert(!f.current().itemShortcuts.some((row) => row.item_id === retired[2]))
    assert(!f.current().itemShortcuts.some((row) => row.slot_id === 2))
    const writes = f.store.db.prepare('SELECT total_changes() n').get().n
    assert.deepEqual(f.snapshot(f.swap(2, a, 3)).at(-1), rows)
    assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, writes)
    assert.deepEqual(f.current().itemShortcutCompatibility, archive)
    f.clear(a, 3)
    f.clear(a, 3)
    f.add(b, 3)
    unchanged(f, () => f.clear(a, 3), ErrorCode.InvalidArgument)
    assert.deepEqual(f.current().itemShortcutCompatibility, archive)
    const g = fixture(t, 'retired-shortcuts-explicit-clear', [retired[0]])
    assert.deepEqual(g.snapshot(g.clear(retired[0], 1)).at(-1), [])
    assert.deepEqual(g.current().itemShortcuts, [])
    assert.deepEqual(g.current().itemShortcutCompatibility.entries[0].original, g.oldRows[0])
    g.reopen()
    assert.deepEqual(g.current().itemShortcuts, [], 'archive must never restore a user-cleared slot')
})

test('first archival login and actual6569 response codec/SQL failures keep the whole raw layout, archive, bag and revision rollback', (t) => {
    const f = fixture(t, 'retired-shortcuts-failures', retired.slice(0, 6), { login: false }),
        before = f.store.load(f.account.id),
        disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.account.id),
        encode = protocol.encode
    const type = protocol.byId.get(6568).rsp
    protocol.encode = function (name, value) {
        if (name === type) throw Error('retired-shortcut-codec')
        return encode.call(this, name, value)
    }
    try {
        assert.throws(() => f.enter(), /retired-shortcut-codec/)
    } finally {
        protocol.encode = encode
    }
    assert.deepEqual(f.store.load(f.account.id), before)
    assert.deepEqual(
        f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.account.id),
        disk,
    )
    f.store.db.exec(
        "CREATE TEMP TRIGGER retired_shortcut_failure BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'retired-shortcut-sql'); END",
    )
    try {
        assert.throws(() => f.enter(), /retired-shortcut-sql/)
    } finally {
        f.store.db.exec('DROP TRIGGER retired_shortcut_failure')
    }
    assert.deepEqual(f.store.load(f.account.id), before)
    assert.deepEqual(
        f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.account.id),
        disk,
    )
    f.enter()
    const archive = structuredClone(f.current().itemShortcutCompatibility),
        a = quick[0].id
    f.grant(a)
    const loaded = f.store.load(f.account.id)
    protocol.encode = function (name, value) {
        if (name === type) throw Error('retired-shortcut-edit-codec')
        return encode.call(this, name, value)
    }
    try {
        assert.throws(() => f.add(a, 1), /retired-shortcut-edit-codec/)
    } finally {
        protocol.encode = encode
    }
    assert.deepEqual(f.store.load(f.account.id), loaded)
    assert.deepEqual(f.current().itemShortcutCompatibility, archive)
    f.add(a, 1)
    f.reopen()
    assert.equal(f.current().itemShortcuts.find((row) => row.slot_id === 1).item_id, a)
    assert.deepEqual(f.current().itemShortcutCompatibility, archive)
})

test('damaged archives and duplicate/invalid stored slots remain GameConfig and cannot partially overwrite known slots', (t) => {
    const f = fixture(t, 'retired-shortcut-damaged', [retired[0]]),
        a = quick[0].id
    f.grant(a)
    for (const edit of [
        (state) => {
            state.itemShortcuts.push({ ...state.itemShortcuts[0] })
        },
        (state) => {
            state.itemShortcutCompatibility.entries[0].original.item_id = 999999999
        },
        (state) => {
            state.itemShortcutCompatibility.version = 2
        },
    ]) {
        const state = structuredClone(f.current())
        edit(state)
        assert.throws(
            () => pruneItemShortcuts(state, f.now()),
            (e) => e.code === ErrorCode.GameConfig,
        )
    }
    const state = structuredClone(f.current())
    state.itemShortcuts = []
    assert.deepEqual(shortcutSnapshot(state, f.now()).item_infos, [])
    assert.equal(pruneItemShortcuts(state, f.now()), false)
    assert.deepEqual(state.itemShortcuts, [])
})

test('real current detector depletion removes every current matching slot while retaining an unrelated historical layout and stock', (t) => {
    const f = detectorFixture(),
        id = retired[0]
    t.after(() => f.close())
    f.edit((state) => {
        // Trusted pre-existing historical stock/layout, not a new grant using
        // a missing item definition. Detector stock came from its real writer.
        const guid = String(state.nextItemGuid)
        state.player.sbag_infos.items.push({ guid, itemtype: 3, itemid: id, itemnum: 1, deadtime: 0 })
        state.nextItemGuid = String(BigInt(guid) + 1n)
        state.itemShortcuts = [{ slot_id: 1, item_id: id }]
    })
    for (const slot of [4, 6])
        f.call('ShortcutKeySet', {
            type: 1,
            item: { src_item: { slot_id: 0, item_id: f.itemId }, tar_item: { slot_id: slot, item_id: 0 } },
        })
    const archive = structuredClone(f.state().itemShortcutCompatibility)
    assert(archive, 'the actual writable shortcut handler remembers the legacy input layout')
    for (let i = 0; i < 2; i++) {
        assert(!f.call('UseItem', { itemid: f.itemId, num: 1 }).some((packet) => packet.id === 6568))
        assert.equal(f.state().itemShortcuts.length, 3)
    }
    const final = f.call('UseItem', { itemid: f.itemId, num: 1 })
    assert.deepEqual(final.find((packet) => packet.id === 6568).data.item_infos, [])
    assert.deepEqual(f.state().itemShortcuts, [{ slot_id: 1, item_id: id }])
    assert.equal(f.state().player.sbag_infos.items.find((row) => row.itemid === f.itemId).itemnum, 0)
    assert.equal(f.state().player.sbag_infos.items.find((row) => row.itemid === id).itemnum, 1)
    assert.deepEqual(f.state().itemShortcutCompatibility, archive)
})
