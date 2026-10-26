import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const entry = protocol.byName.get('CSProtoSetNewerFlag')
function fixture(name, filename = ':memory:') {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, data = {}, sequence) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: row.id, seq: sequence ?? seq++, payload: protocol.encode(row.req, data) })
    }
    return {
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        login: () => call('Login', { open_id: name }),
        enter: () => call('EnterGame', { open_id: name }),
    }
}
const changes = (store) => store.db.prepare('SELECT total_changes() AS count').get().count
const sqlSnapshot = (store) =>
    Object.fromEntries(
        store.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map(({ name }) => [
                name,
                store.db
                    .prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"')
                    .all()
                    .map((row) => JSON.stringify(row))
                    .sort(),
            ]),
    )
const error = (code) => (failure) => failure.code === code
function reply(packets, sequence) {
    assert.equal(packets.length, 1)
    assert.equal(packets[0].id, entry.id)
    assert.equal(packets[0].seq, sequence)
    assert.equal(packets[0].error ?? ErrorCode.Succ, ErrorCode.Succ)
    assert.equal(packets[0].payload.length, 0)
    assert.deepEqual(protocol.decode(entry.rsp, packets[0].payload), {})
}

test('observed default download notifications work before and after EnterGame, with duplicate0 replies and no player/task writes', () => {
    const f = fixture('newerflag-default')
    try {
        f.login()
        assert.equal(f.session.entered, false)
        let before = structuredClone(f.state()),
            count = changes(f.store)
        reply(f.call('SetNewerFlag', {}, 21), 21)
        assert.deepEqual(f.state(), before)
        assert.equal(changes(f.store), count)
        f.enter()
        before = structuredClone(f.state())
        const disk = sqlSnapshot(f.store)
        count = changes(f.store)
        for (const request of [{}, { u32: 0 }, {}]) reply(f.call('SetNewerFlag', request, 44), 44)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(sqlSnapshot(f.store), disk)
        assert.equal(changes(f.store), count)
    } finally {
        f.store.close()
    }
})

test('login and malformed packet guards stay independent; all nonzero selectors diagnose and reject FunctionClosed even if logging fails', () => {
    const f = fixture('newerflag-rejections'),
        warn = console.warn,
        seen = []
    try {
        assert.throws(() => f.call('SetNewerFlag'), error(ErrorCode.HaveNotEnterGame))
        f.login()
        const before = structuredClone(f.state()),
            count = changes(f.store)
        console.warn = (label, text) => seen.push({ label, data: JSON.parse(text) })
        for (const u32 of [1, 0xffffffff])
            assert.throws(() => f.call('SetNewerFlag', { u32 }), error(ErrorCode.FunctionClosed))
        assert.deepEqual(
            seen.map((row) => row.data.u32),
            [1, 0xffffffff],
        )
        assert(seen.every((row) => row.label === '[newerflag-compat]' && row.data.action === 'FunctionClosed'))
        console.warn = () => {
            throw Error('diagnostic sink unavailable')
        }
        assert.throws(() => f.call('SetNewerFlag', { u32: 9 }), error(ErrorCode.FunctionClosed))
        assert.throws(
            () => f.game.dispatch(f.session, { id: entry.id, seq: 5, payload: Buffer.from([8]) }),
            error(ErrorCode.InvalidPacket),
        )
        assert.deepEqual(f.state(), before)
        assert.equal(changes(f.store), count)
    } finally {
        console.warn = warn
        f.store.close()
    }
})

test('private SQLite, deferred references and codec failure prove notification skips Store transactions and keeps9904/2519 completion independent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newerflag-compat-')),
        filename = path.join(directory, 'state.sqlite')
    const f = fixture('newerflag-sqlite', filename),
        encode = protocol.encode
    let reopened
    try {
        f.enter()
        f.store.transact(f.session.id, 0, () => {}, { defer: true })
        const pending = f.store.pending.get(f.session.id),
            player = pending.state.player,
            tasks = pending.state.tasks
        const before = structuredClone(f.state()),
            disk = sqlSnapshot(f.store),
            count = changes(f.store)
        const methods = Object.fromEntries(['read', 'load', 'transact'].map((name) => [name, f.store[name]]))
        f.store.db.exec(
            "CREATE TEMP TRIGGER newerflag_block_update BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'notification attempted a write'); END",
        )
        try {
            for (const name of Object.keys(methods))
                f.store[name] = () => {
                    throw Error('notification called Store.' + name)
                }
            reply(f.call('SetNewerFlag', {}, 77), 77)
            protocol.encode = function (name, ...args) {
                if (name === entry.rsp) throw Error('newerflag response codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('SetNewerFlag'), /newerflag response codec/)
            protocol.encode = encode
            reply(f.call('SetNewerFlag', { u32: 0 }, 78), 78)
        } finally {
            protocol.encode = encode
            for (const [name, fn] of Object.entries(methods)) f.store[name] = fn
            f.store.db.exec('DROP TRIGGER newerflag_block_update')
        }
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.equal(pending.state.player, player)
        assert.equal(pending.state.tasks, tasks)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(sqlSnapshot(f.store), disk)
        assert.equal(changes(f.store), count)
        // Closing now flushes only the independently created pre-existing noop
        // pending draft; the download notifications never added a write/receipt.
        f.store.close()
        reopened = new Store(filename)
        assert.deepEqual(reopened.load(f.session.id).state, before)
        assert(fs.readFileSync(path.join(cfg.base, 'src/task-events.js'), 'utf8').includes('r.key === 2519'))
    } finally {
        protocol.encode = encode
        reopened?.close()
        try {
            f.store.close()
        } catch {}
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('newerflag-compat-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
