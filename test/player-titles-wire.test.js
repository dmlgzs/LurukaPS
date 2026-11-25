import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
import {
    playerTitleList,
    playerTitleSnapshot,
    playerTitleWireSnapshot,
    changePlayerTitle,
    grantPlayerTitle,
} from '../src/player-titles.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(filename = ':memory:') {
    const store = new Store(filename),
        account = store.login('title-wire-1.0', () => ({
            player: { basic_info: {} },
            titles: { preffix_title: [], suffix_title: [] },
        }))
    return {
        store,
        id: account.id,
        state: () => store.load(account.id).state,
        list: () =>
            protocol.decode(
                'cs.TitleList',
                protocol.encode('cs.TitleList', playerTitleList(store, tables, account.id)),
            ),
        mutate: (fn) => store.transact(account.id, 10301, fn),
    }
}
function optionalTitle(type) {
    const defaults = new Set(
        String(tables.get('game').find((row) => row.title === 'PLAYERTITLE_DEFAULT').value)
            .split('|')
            .map(Number),
    )
    return tables.get('player_title').find((row) => row.type === type && !defaults.has(row.id)).id
}

test('10300 1.0 returns TitleInfo rows while preserving legacy ownership and permanent missing-deadtime semantics', () => {
    const f = fixture()
    try {
        const before = f.state(),
            writes = f.store.db.prepare('SELECT total_changes() n').get().n,
            result = f.list()
        assert.ok(result.infos.length >= 2)
        assert.equal(Object.hasOwn(result, 'preffix_title'), false)
        assert.equal(Object.hasOwn(result, 'suffix_title'), false)
        for (const info of result.infos) {
            assert.equal(info.type, tables.find('player_title', info.id).type)
            assert.equal(Object.hasOwn(info, 'deadtime'), false)
            const luaDeadline = info.deadtime === undefined ? 0 : info.deadtime + 1
            assert.equal(luaDeadline, 0)
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, writes)
        const old = playerTitleSnapshot(tables, f.state())
        assert.deepEqual(result.infos, [
            ...old.preffix_title.map((id) => ({ id, type: 1 })),
            ...old.suffix_title.map((id) => ({ id, type: 2 })),
        ])
    } finally {
        f.store.close()
    }
})

test('existing type17 grant ownership, default selection and repeat grants remain unchanged by the wire projection', () => {
    const f = fixture(),
        pre = optionalTitle(1),
        suffix = optionalTitle(2)
    try {
        f.mutate((s) => {
            assert.equal(grantPlayerTitle(tables, s, pre), true)
            assert.equal(grantPlayerTitle(tables, s, suffix), true)
            assert.equal(grantPlayerTitle(tables, s, pre), false)
            changePlayerTitle({ state: s, tables }, { type: 1, id: pre })
            changePlayerTitle({ state: s, tables }, { type: 2, id: suffix })
        })
        const result = f.list()
        assert.ok(result.infos.some((row) => row.id === pre && row.type === 1))
        assert.ok(result.infos.some((row) => row.id === suffix && row.type === 2))
        assert.equal(result.infos.filter((row) => row.id === pre).length, 1)
        assert.deepEqual(f.state().titles, { preffix_title: [pre], suffix_title: [suffix] })
        assert.equal(f.state().player.basic_info.preffix_title, pre)
        assert.equal(f.state().player.basic_info.suffix_title, suffix)
    } finally {
        f.store.close()
    }
})

test('wire list cache follows saved and pending Store tokens without loading profiles or rewriting ownership', () => {
    const f = fixture(),
        pre = optionalTitle(1)
    try {
        f.list()
        const originalRead = f.store.read.bind(f.store)
        let reads = 0
        f.store.read = (...args) => {
            reads++
            return originalRead(...args)
        }
        f.store.load = () => {
            throw Error('query must not load profile')
        }
        const writes = f.store.db.prepare('SELECT total_changes() n').get().n
        f.list()
        f.list()
        assert.equal(reads, 0)
        assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, writes)
        f.store.read = originalRead
        // Restore ordinary load before creating a deferred draft, then ensure the
        // cache sees its independent token rather than the still-old SQL revision.
        f.store.load = Store.prototype.load.bind(f.store)
        f.store.transact(f.id, 0, (s) => grantPlayerTitle(tables, s, pre), { defer: true })
        assert.ok(f.list().infos.some((row) => row.id === pre))
    } finally {
        f.store.close()
    }
})

test('invalid old ownership and exact title request errors remain strict and atomic', () => {
    const f = fixture(),
        pre = optionalTitle(1)
    try {
        const before = f.state()
        assert.throws(
            () => f.mutate((s) => changePlayerTitle({ state: s, tables }, { type: 1, id: pre })),
            (e) => e.code === ErrorCode.PlayerHadNotTheTitle,
        )
        assert.deepEqual(f.state(), before)
        assert.throws(
            () => playerTitleWireSnapshot(tables, { titles: { preffix_title: [172000] } }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.throws(
            () => f.mutate((s) => changePlayerTitle({ state: s, tables }, { type: 0, id: 171000 })),
            (e) => e.code === ErrorCode.TitleTypeFail,
        )
        assert.throws(() => protocol.encode('cs.TitleList', { preffix_title: [171000] }), /Unknown field/)
    } finally {
        f.store.close()
    }
})

test('real SQLite reopen preserves permanent legacy ownership and new TitleList encodes every configured owned title', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-title-wire-')),
        filename = path.join(directory, 'state.sqlite')
    let f = fixture(filename)
    try {
        f.mutate((s) => {
            for (const row of tables.get('player_title')) grantPlayerTitle(tables, s, row.id)
        })
        const before = f.list()
        f.store.close()
        f = fixture(filename)
        assert.deepEqual(f.list(), before)
        assert.equal(before.infos.length, tables.get('player_title').length)
    } finally {
        f.store.close()
        const resolved = fs.realpathSync(directory)
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
        assert.ok(path.basename(resolved).startsWith('lurukaps-title-wire-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
