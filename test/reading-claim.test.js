import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards } from '../src/rewards.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function fixture(file = ':memory:') {
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'reading-claim' })
    store.transact(session.id, 0, (state) => {
        state.readingBooks = {}
        state.tasks = []
        state.taskRecords = tables
            .get('task')
            .filter((t) => t.type === 1)
            .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
    })
    return {
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        close: () => store.close(),
    }
}
const acquire = (f, id) => f.call('ReadHandbookGet', { book_id: id, get_type: 1 })

test('11026 creates a real unread book via the unified type28 ledger and synchronizes it before the null reply', () => {
    const f = fixture()
    try {
        const before = f.state(),
            out = acquire(f, 10001)
        assert.deepEqual(f.state().readingBooks[10001], { book_id: 10001, book_state: 0 })
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(f.state().player.basic_info, before.player.basic_info)
        const sync = assertSyncBefore(protocol, out, 'CSProtoReadHandbookInfoSync', 11026)
        assert.equal(sync.at(-1).data.send_type, 1)
        assert.deepEqual(sync.at(-1).data.infos, [{ book_id: 10001, book_state: 0 }])
        assert.equal(out.filter((p) => p.id === 11026).length, 1)
        assert.equal(out.filter((p) => p.data.rewards?.length).length, 0)
    } finally {
        f.close()
    }
})

test('all current reading IDs are acquired from tables without per-book cases or invented series rewards', () => {
    const f = fixture()
    try {
        const books = tables.get('library_readings'),
            before = f.state()
        assert(books.length > 0)
        assert.equal(new Set(books.map((b) => b.id)).size, books.length)
        for (const book of books) {
            const out = acquire(f, book.id)
            assertSyncBefore(protocol, out, 'CSProtoReadHandbookInfoSync', 11026)
            assert.deepEqual(f.state().readingBooks[book.id], { book_id: book.id, book_state: 0 })
        }
        assert.equal(Object.keys(f.state().readingBooks).length, books.length)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold)
        assert.equal(f.state().player.basic_info.diamond, before.player.basic_info.diamond)
    } finally {
        f.close()
    }
})

test('read and repeated acquisition preserve owned state and do not replay collection notifications', () => {
    const f = fixture()
    try {
        acquire(f, 10001)
        f.call('ReadHandbookRead', { book_id: [10001] })
        assert.equal(f.state().readingBooks[10001].book_state, 1)
        const books = structuredClone(f.state().readingBooks),
            out = acquire(f, 10001)
        assert.deepEqual(f.state().readingBooks, books)
        assert(!out.some((p) => p.id === protocol.byName.get('CSProtoReadHandbookInfoSync').id))
        acquire(f, 10002)
        assert.equal(f.state().readingBooks[10001].book_state, 1)
        assert.equal(f.state().readingBooks[10002].book_state, 0)
        f.call('ReadHandbookRead', { book_id: [10001, 10002] })
        assert.equal(f.state().readingBooks[10002].book_state, 1)
    } finally {
        f.close()
    }
})

test('unknown books, unsupported source kinds and corrupt existing records fail without creating or resetting books', () => {
    const f = fixture()
    try {
        for (const [request, code] of [
            [{ book_id: 0, get_type: 1 }, ErrorCode.HandbookConfNone],
            [{ book_id: 999999, get_type: 1 }, ErrorCode.HandbookConfNone],
            [{ book_id: 10001 }, ErrorCode.HandbookTypeLimit],
            [{ book_id: 10001, get_type: 2 }, ErrorCode.HandbookTypeLimit],
            [{ book_id: 10001, get_type: 999 }, ErrorCode.HandbookTypeLimit],
        ]) {
            const before = f.store.load(f.session.id)
            assert.throws(
                () => f.call('ReadHandbookGet', request),
                (e) => e.code === code,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        f.edit((state) => {
            state.readingBooks[10001] = { book_id: 10002, book_state: 0 }
        })
        const before = f.store.load(f.session.id)
        assert.throws(
            () => acquire(f, 10001),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})

test('book synchronization and actual null-reply encoding failures roll back acquisition', () => {
    const f = fixture(),
        packet = f.game.packet,
        encode = protocol.encode
    try {
        const before = f.store.load(f.session.id)
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoReadHandbookInfoSync') throw Error('reading synchronization failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => acquire(f, 10001), /reading synchronization failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        const reply = protocol.byName.get('CSProtoReadHandbookGet').rsp
        protocol.encode = function (type, data, ...args) {
            if (type === reply) throw Error('reading reply failed')
            return encode.call(this, type, data, ...args)
        }
        assert.throws(() => acquire(f, 10001), /reading reply failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        protocol.encode = encode
        acquire(f, 10001)
        assert.deepEqual(Object.keys(f.state().readingBooks), ['10001'])
    } finally {
        protocol.encode = encode
        f.game.packet = packet
        f.close()
    }
})

test('type28 world/task reward acquisition and 11026 share one persistent book record, independently for each account', () => {
    const f = fixture()
    try {
        f.edit((state) => grantRewards(tables, state, [{ itemtype: 28, itemid: 10001, itemnum: 1 }]))
        f.call('ReadHandbookRead', { book_id: [10001] })
        acquire(f, 10001)
        assert.deepEqual(f.state().readingBooks[10001], { book_id: 10001, book_state: 1 })
        const other = {}
        f.call('EnterGame', { open_id: 'reading-second-account' }, other)
        assert(!f.store.load(other.id).state.readingBooks?.[10001])
        assert.throws(() => f.call('ReadHandbookRead', { book_id: [10001] }, other), /not owned/)
        f.call('ReadHandbookGet', { book_id: 10001, get_type: 1 }, other)
        assert.equal(f.store.load(other.id).state.readingBooks[10001].book_state, 0)
        assert.equal(f.state().readingBooks[10001].book_state, 1)
    } finally {
        f.close()
    }
})

test('real SQLite restart preserves acquired and read states and login does not announce old collection as new', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-reading-'))
    const file = path.join(directory, 'state.sqlite'),
        f = fixture(file)
    let store,
        closed = false
    try {
        acquire(f, 10001)
        acquire(f, 10002)
        f.call('ReadHandbookRead', { book_id: [10001] })
        const expected = f.state().readingBooks
        f.close()
        closed = true
        store = new Store(file)
        const game = new Game(protocol, store, tables),
            session = {},
            entry = protocol.byName.get('CSProtoEnterGame')
        const packets = game.dispatch(session, {
            id: entry.id,
            seq: 1,
            payload: protocol.encode(entry.req, { open_id: 'reading-claim' }),
        })
        assert.equal(session.id, f.session.id)
        assert.deepEqual(store.load(session.id).state.readingBooks, expected)
        const sync = protocol.byName.get('CSProtoReadHandbookInfoSync'),
            packet = packets.find((p) => p.id === sync.id)
        assert(packet)
        const data = protocol.decode(sync.rsp, packet.payload)
        assert.notEqual(data.send_type, 1)
        assert(data.infos.some((b) => b.book_id === 10001 && b.book_state === 1))
        assert(data.infos.some((b) => b.book_id === 10002 && b.book_state === 0))
    } finally {
        if (!closed) f.close()
        store?.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-reading-'))
        fs.rmSync(directory, { recursive: true })
    }
})
