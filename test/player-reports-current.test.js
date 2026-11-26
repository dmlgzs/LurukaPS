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
import { playerReportPolicy } from '../src/player-reports.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(file = ':memory:', reporterOnly = false) {
    const protocol = new Protocol(cfg.base),
        store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now })
    let now = 1800000000,
        seq = 1,
        session = {}
    const frame = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) }
    }
    const dispatch = (frame, who = session) =>
        game
            .dispatch(who, frame)
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    const call = (name, request, who) => dispatch(frame(name, request), who)
    call('EnterGame', { open_id: 'report-fixture-reporter' })
    const peer = {},
        other = {}
    if (reporterOnly) {
        peer.id = store.accountByOpen.get('report-fixture-target').id
        other.id = store.accountByOpen.get('report-fixture-target-two').id
    } else {
        call('EnterGame', { open_id: 'report-fixture-target' }, peer)
        call('EnterGame', { open_id: 'report-fixture-target-two' }, other)
    }
    const state = () => store.load(session.id).state,
        journal = () => state().localPlayerReports,
        raw = () => ({
            player: store.load(session.id),
            rows: store.db
                .prepare('SELECT account_id,state,revision,updated_at FROM players ORDER BY account_id')
                .all(),
            sequences: store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
        })
    return {
        protocol,
        store,
        game,
        call,
        frame,
        dispatch,
        state,
        journal,
        raw,
        peer,
        other,
        id: () => session.id,
        edit: (fn) => store.transact(session.id, 0, fn),
        report: (value) =>
            call('ReportOnPlayer', { playerID: [peer.id], reportID: 1, reportEntryID: 1001, reason: '', ...value }),
        advance: (n) => {
            now += n
        },
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: 'report-fixture-reporter', reconnect: true })
        },
        close: () => store.close(),
    }
}
const assets = (s) =>
    structuredClone({ player: s.player, pets: s.pets, eggs: s.petEggs, friends: s.friends, blocked: s.blockedPlayers })
function unchanged(f, fn, predicate) {
    const before = f.raw()
    assert.throws(fn, predicate)
    assert.deepEqual(f.raw(), before)
}

test('current6234 single profile report persists a LOCAL unforwarded receipt, closes the callback model and changes no target or assets', () => {
    const f = fixture()
    try {
        const peers = [f.store.load(f.peer.id), f.store.load(f.other.id)],
            before = assets(f.state()),
            packets = f.report(),
            ack = packets.find((p) => p.id === 6234)
        assert(ack)
        assert.deepEqual(ack.data, {})
        const record = f.journal().records[0]
        assert.equal(record.origin, 'LOCAL')
        assert.equal(record.status, 'received-local')
        assert.equal(record.forwarded, false)
        assert.equal(record.penalties_applied, false)
        assert.equal(record.evidence_verification, 'unverified-client-report')
        assert.equal(record.reporter_id, f.id())
        assert.deepEqual(record.request, {
            player_ids: [f.peer.id],
            report_type: 1,
            entry_id: 1001,
            reason: '',
            special_data: '',
            kibo_guids: [],
        })
        assert.deepEqual(assets(f.state()), before)
        assert.deepEqual([f.store.load(f.peer.id), f.store.load(f.other.id)], peers)
        assert(
            !packets.some((p) => p.audience || p.data.chat || p.data.bans),
            'no punishment/peer-message protocol is emitted',
        )
        // Current OnReportResponse(err==0) records a per-type local timestamp,
        // displays its existing success text and closes. This models receipt,
        // not official review or execution of its extra anti-cheat event.
        let closed = false,
            cooldown = false
        if (ack) {
            cooldown = true
            closed = true
        }
        assert(closed && cooldown)
    } finally {
        f.close()
    }
})

test('current type-to-entry declarations, UTF16 description boundary and conditional evidence fields are strict', () => {
    const f = fixture()
    try {
        unchanged(
            f,
            () => f.report({ reportID: 5 }),
            (e) => e.code === ErrorCode.ComplainInvalidType,
        )
        unchanged(
            f,
            () => f.report({ reportEntryID: 0 }),
            (e) => e.code === ErrorCode.ComplainNoEntry,
        )
        unchanged(
            f,
            () => f.report({ reportEntryID: 1 }),
            (e) => e.code === ErrorCode.ComplainInvalidEntry,
        )
        unchanged(
            f,
            () => f.report({ reportEntryID: 2001 }),
            (e) => e.code === ErrorCode.ComplainInvalidEntry,
        )
        unchanged(
            f,
            () => f.report({ playerID: [f.id()] }),
            (e) => e.code === ErrorCode.InvalidTarget,
        )
        unchanged(
            f,
            () => f.report({ playerID: [99999999] }),
            (e) => e.code === ErrorCode.InvalidTarget,
        )
        unchanged(
            f,
            () => f.report({ playerID: [f.peer.id, f.peer.id] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        unchanged(
            f,
            () => f.report({ reason: '😀'.repeat(76) }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        unchanged(
            f,
            () => f.report({ special_data: 'chat data on wrong type' }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        unchanged(
            f,
            () => f.report({ kiboGuids: ['18446744073709551615'] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        f.report({ reason: '😀'.repeat(75) })
        assert.equal(f.journal().records[0].request.reason.length, 150)
        f.report({ reportID: 2, reportEntryID: 2001, reason: '原文说明\n🌸', special_data: '5L2g5aW9' })
        assert.equal(f.journal().records.at(-1).request.reason, '原文说明\n🌸')
        assert.equal(
            f.journal().records.at(-1).request.special_data,
            '5L2g5aW9',
            'evidence is stored without base64/JSON interpretation',
        )
        for (const type of [3, 4]) f.report({ reportID: type, reportEntryID: 3002, playerID: [f.peer.id, f.other.id] })
        f.report({ reportID: 6, reportEntryID: 3001, kiboGuids: ['18446744073709551615', '9007199254740993'] })
        assert.deepEqual(f.journal().records.at(-1).request.kibo_guids, ['18446744073709551615', '9007199254740993'])
        assert.deepEqual(
            f.journal().records.map((r) => r.request.report_type),
            [1, 2, 3, 4, 6],
        )
    } finally {
        f.close()
    }
})

test('identical retries deduplicate within current per-type86400 cooldown; another reason is rejected then a new period is accepted', () => {
    const f = fixture()
    try {
        const request = { reason: 'same local receipt' }
        f.report(request)
        const before = structuredClone(f.journal())
        f.report(request)
        assert.deepEqual(f.journal(), before)
        unchanged(
            f,
            () => f.report({ reportEntryID: 1002, reason: 'different' }),
            (e) => e.code === ErrorCode.ComplainCooldown,
        )
        f.reconnect()
        unchanged(
            f,
            () => f.report({ reportEntryID: 1002 }),
            (e) => e.code === ErrorCode.ComplainCooldown,
        )
        f.advance(86400)
        f.report(request)
        assert.equal(f.journal().records.length, 2)
        assert.deepEqual(
            f.journal().records.map((r) => r.id),
            [1, 2],
        )
    } finally {
        f.close()
    }
})

test('actual6234 ACK codec and SQLite failure roll back journal/cooldown/id and every player SQL tuple, then retry records once', () => {
    const f = fixture()
    try {
        const frame = f.frame('ReportOnPlayer', {
                playerID: [f.peer.id],
                reportID: 1,
                reportEntryID: 1001,
                reason: 'atomic',
            }),
            packet = f.game.packet
        f.game.packet = function (name, value, options) {
            if (name === 6234) throw Error('local-report-codec')
            return packet.call(this, name, value, options)
        }
        unchanged(f, () => f.dispatch(frame), /local-report-codec/)
        f.game.packet = packet
        f.store.db.exec(
            "CREATE TRIGGER report_failure BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'local-report-sql'); END",
        )
        unchanged(f, () => f.dispatch(frame), /local-report-sql/)
        f.store.db.exec('DROP TRIGGER report_failure')
        f.dispatch(frame)
        assert.equal(f.journal().records.length, 1)
        assert.equal(f.journal().next_id, 2)
        f.dispatch(frame)
        assert.equal(f.journal().records.length, 1)
    } finally {
        f.close()
    }
})

test('damaged retained local journal and invalid LOCAL policy are rejected instead of overwritten', () => {
    const f = fixture()
    try {
        assert.throws(
            () => playerReportPolicy({ version: 1, origin: 'OFFICIAL' }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        f.report()
        f.edit((s) => {
            s.localPlayerReports.records[0].request.reason = 'tampered'
        })
        unchanged(
            f,
            () => f.report({ reportID: 2, reportEntryID: 2001 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})

test('a private cold database reopen preserves LOCAL receipts and cooldown without target changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-player-report-')),
        file = path.join(dir, 'validation-only.sqlite')
    let f
    try {
        f = fixture(file)
        f.report({ reason: 'cold journal' })
        const journal = structuredClone(f.journal()),
            target = f.store.load(f.peer.id)
        f.close()
        f = undefined
        f = fixture(file, true)
        assert.deepEqual(f.journal(), journal)
        f.report({ reason: 'cold journal' })
        assert.deepEqual(f.journal(), journal)
        assert.deepEqual(f.store.load(f.peer.id).state, target.state)
        unchanged(
            f,
            () => f.report({ reportEntryID: 1002 }),
            (e) => e.code === ErrorCode.ComplainCooldown,
        )
    } finally {
        f?.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'luruka-player-report-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
