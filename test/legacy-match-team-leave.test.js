import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables)
const material = tables.get('dungeon_material').find((row) => row.unlock === '2004#1')
function fixture() {
    const store = new Store(':memory:'),
        protocol = new Protocol(config.base)
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        sessions = [{}, {}, {}]
    let seq = 1
    const call = (id, name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(sessions[id - 1], { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, value) })
    }
    for (let i = 1; i <= 3; i++) call(i, 'EnterGame', { open_id: 'legacy-room-leave-' + i })
    const create = (id = 1) => call(id, 'CreateMatchTeam', { dungeon_id: material.dungeonId, scene_type: 12 })
    const room = (id = 1) => game.legacyMatchTeams.roomFor(sessions[id - 1].id)
    // Explicitly a repository-level test fixture for the future join branch,
    // not a claim that the invitation protocol is already implemented.
    const members = () =>
        store.transact(sessions[0].id, 0, () => {
            const saved = room()
            for (let id = 2; id <= 3; id++) {
                saved.members.push({ id: sessions[id - 1].id, joined_at: 1800000000 + id })
                store.db
                    .prepare('INSERT INTO legacy_match_members(player_id,room_id) VALUES(?,?)')
                    .run(sessions[id - 1].id, saved.id)
            }
            store.db.prepare('UPDATE legacy_match_rooms SET payload=? WHERE id=?').run(JSON.stringify(saved), saved.id)
        })
    return {
        store,
        protocol,
        game,
        sessions,
        call,
        create,
        room,
        members,
        decode: (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
    }
}
const code = (expected) => (error) => error.code === expected

test('9523 empty/default leave deletes a solo room, uses9549 without ACK, and never reuses its identity', () => {
    const f = fixture()
    try {
        f.create()
        const first = f.room().id,
            packets = f.call(1, 'LeaveMatchTeam')
        assert(!packets.some((packet) => packet.id === 9523))
        assert.deepEqual(f.decode(packets.find((packet) => packet.id === 9549)), { reason: 0 })
        assert.equal(f.room(), null)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_rooms').get().n, 0)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_members').get().n, 0)
        assert.throws(() => f.call(1, 'LeaveMatchTeam'), code(ErrorCode.NotInMatchTeam))
        f.create()
        assert.equal(f.room().id, first + 1)
    } finally {
        f.store.close()
    }
})

test('a member leaves only its own index, while captain leave deterministically transfers to the first remaining member', () => {
    const f = fixture()
    try {
        f.create()
        f.members()
        const before = f.room(),
            state = structuredClone(f.store.load(1).state)
        const packets = f.call(2, 'LeaveMatchTeam', { u32: 0 })
        assert.equal(f.room(2), null)
        assert.equal(f.room().captain, 1)
        assert.deepEqual(
            f.room().members.map((member) => member.id),
            [1, 3],
        )
        assert.deepEqual(
            packets
                .filter((packet) => packet.id === 9543)
                .map((packet) => packet.recipient ?? 2)
                .sort(),
            [1, 2, 3],
        )
        for (const packet of packets.filter((packet) => packet.id === 9543))
            assert.deepEqual(f.decode(packet), { player_id: 2, new_captain: 1, reason: 0 })
        assert.deepEqual(f.store.load(1).state, state)
        assert.equal(f.room().id, before.id)
        const transfer = f.call(1, 'LeaveMatchTeam')
        assert.equal(f.room(), null)
        assert.equal(f.room(3).captain, 3)
        assert.deepEqual(
            f.room(3).members.map((member) => member.id),
            [3],
        )
        assert(transfer.some((packet) => packet.id === 9543 && f.decode(packet).new_captain === 3))
        const sync = transfer.find((packet) => packet.id === 9520)
        assert.equal(sync.recipient, 3)
        assert.deepEqual(
            f.decode(sync).team.members.map((member) => member.pid),
            [3],
        )
    } finally {
        f.store.close()
    }
})

test('only the captain can dissolve the entire room; all nonzero uint32 flags follow the declared contract', () => {
    const f = fixture()
    try {
        f.create()
        f.members()
        const before = f.room()
        assert.throws(() => f.call(2, 'LeaveMatchTeam', { u32: 1 }), code(ErrorCode.IsNotMatchTeamLeader))
        assert.deepEqual(f.room(), before)
        const packets = f.call(1, 'LeaveMatchTeam', { u32: 0xffffffff })
        assert.deepEqual(
            packets
                .filter((packet) => packet.id === 9549)
                .map((packet) => packet.recipient ?? 1)
                .sort(),
            [1, 2, 3],
        )
        for (let id = 1; id <= 3; id++) assert.equal(f.room(id), null)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_rooms').get().n, 0)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_members').get().n, 0)
    } finally {
        f.store.close()
    }
})

test('peer notification encoding failures roll back both dismissal and ordinary leave without publishing partial membership', () => {
    for (const [flag, failingId] of [
        [1, 9549],
        [0, 9543],
        [0, 9520],
    ]) {
        const f = fixture(),
            original = f.protocol.encode.bind(f.protocol)
        try {
            f.create()
            f.members()
            const before = f.room()
            f.protocol.encode = (type, data) => {
                if (type === f.protocol.byId.get(failingId).rsp) throw Error('isolated peer packet encoding failure')
                return original(type, data)
            }
            assert.throws(() => f.call(1, 'LeaveMatchTeam', { u32: flag }), /isolated peer packet encoding failure/)
            for (let id = 1; id <= 3; id++) assert.deepEqual(f.room(id), before)
            f.protocol.encode = original
            f.call(1, 'LeaveMatchTeam', { u32: flag })
            assert.equal(f.room(), null)
        } finally {
            f.protocol.encode = original
            f.store.close()
        }
    }
})

test('a corrupt optional room cannot trap login, while room operations preserve and reject its damaged ledger', () => {
    const f = fixture(),
        warnings = [],
        warn = console.warn
    try {
        f.create()
        const room = f.room()
        f.store.db.prepare('UPDATE legacy_match_rooms SET payload=? WHERE id=?').run('{', room.id)
        console.warn = (text) => warnings.push(text)
        const session = {},
            entry = f.protocol.byName.get('CSProtoEnterGame')
        const packets = f.game.dispatch(session, {
            id: entry.id,
            seq: 999,
            payload: f.protocol.encode(entry.req, { open_id: 'legacy-room-leave-1' }),
        })
        assert.equal(session.entered, true)
        assert.equal(
            packets.some((packet) => packet.id === 9520),
            false,
        )
        assert(warnings.some((text) => text.includes('[legacy-match-team] login snapshot omitted')))
        assert.throws(() => f.call(1, 'LeaveMatchTeam'), code(ErrorCode.GameConfig))
        assert.equal(f.store.db.prepare('SELECT payload FROM legacy_match_rooms WHERE id=?').get(room.id).payload, '{')
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_members').get().n, 1)
    } finally {
        console.warn = warn
        f.store.close()
    }
})
