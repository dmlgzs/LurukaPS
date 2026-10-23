import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ErrorCode } from '../src/error-codes.js'
import { teamFixture, teamTables } from './legacy-match-team-fixture.js'
const rows = teamTables.get('dungeon_crisiscrusade').filter((row) => row.taskUnlock === '2004#1')
const code = (expected) => (error) => error.code === expected
function party(f, count = 3) {
    f.create(1, rows[0].dungeonId)
    for (let i = 2; i <= count; i++) {
        f.invite(1, i, i - 1)
        f.call(i, 'ReplyInviteJoin', { invite_id: String(f.room().id), is_accept: true })
    }
}
const propose = (f, row = rows[1]) => f.call(1, 'ChangeDungeon', { dungeon_id: row.dungeonId, scene_type: 12 })
const vote = (f, index, accept = true) => f.call(index, 'ReplyChangeDungeon', { accept })
const commit = (f, row = rows[1]) =>
    f.game.dispatch(f.sessions[0], {
        id: 9536,
        seq: 60000,
        payload: f.protocol.encode('cs.ChangeDungeonSync', { dungeon_id: row.dungeonId, ask: false }),
    })

test('real three-player decisions go only to the initiating captain and require its final9536 before changing the target', () => {
    const f = teamFixture({ count: 3, account: 'real-target-votes' })
    try {
        party(f)
        propose(f)
        const old = f.room()
        const first = vote(f, 2)
        assert(!first.some((packet) => packet.id === 9547))
        const notices = first.filter((packet) => packet.id === 9548)
        assert.equal(notices.length, 1)
        assert.equal(notices[0].recipient, f.id(1))
        assert.deepEqual(f.decode(notices[0]), { player_id: f.id(2), accept: true })
        assert.deepEqual(f.room(), old)
        assert.throws(() => commit(f), code(ErrorCode.TeamWaitStateSync))
        vote(f, 3)
        assert.deepEqual(f.room(), old, 'all-Yes alone must not bypass the real captain confirmation')
        const packets = commit(f),
            room = f.room()
        assert.equal(room.target.dungeon_id, rows[1].dungeonId)
        assert.equal(room.revision, old.revision + 1)
        assert.deepEqual(room.members, old.members)
        assert.equal(f.teams.changes.get(room.id).status, 'committed')
        assert.equal(packets.filter((packet) => packet.id === 9546).length, 3)
        assert.equal(packets.filter((packet) => packet.id === 9520).length, 3)
        for (const packet of packets.filter((packet) => packet.id === 9546))
            assert.equal(f.decode(packet).cancel, false)
    } finally {
        f.store.close()
    }
})

test('known votes are idempotent, a late timer cannot reverse the first choice, and duplicate proposal restores only the captain map', () => {
    const f = teamFixture({ count: 3, account: 'duplicate-votes' })
    try {
        party(f)
        propose(f)
        vote(f, 2)
        const pending = f.teams.changes.get(f.room().id)
        vote(f, 2, false)
        assert.deepEqual(f.teams.changes.get(f.room().id), pending)
        const packets = propose(f)
        assert(!packets.some((packet) => packet.id === 9546))
        assert.deepEqual(
            packets.filter((packet) => packet.id === 9548).map((packet) => f.decode(packet)),
            [{ player_id: f.id(2), accept: true }],
        )
        assert.deepEqual(f.teams.changes.get(f.room().id), pending)
        vote(f, 3)
        commit(f)
        const saved = f.room(),
            closed = f.teams.changes.get(saved.id)
        assert(!vote(f, 3).some((packet) => packet.id === 9548))
        commit(f)
        assert.deepEqual(f.room(), saved)
        assert.deepEqual(f.teams.changes.get(saved.id), closed)
    } finally {
        f.store.close()
    }
})

test('empty9547 is a real No decision, atomically closes the proposal and prevents a later final from applying the rejected target', () => {
    const f = teamFixture({ count: 3, account: 'empty-no' })
    try {
        party(f)
        propose(f)
        assert.equal(f.protocol.encode(f.protocol.byId.get(9547).req, {}).length, 0)
        const packets = f.call(2, 'ReplyChangeDungeon', {})
        const receipt = packets.find((packet) => packet.id === 9548)
        assert.equal(receipt.recipient, f.id(1))
        assert.deepEqual(f.decode(receipt), { player_id: f.id(2), accept: false })
        assert.equal(f.teams.changes.get(f.room().id).status, 'declined')
        assert.equal(f.room().target.dungeon_id, rows[0].dungeonId)
        assert.equal(packets.filter((packet) => packet.id === 9546).length, 3)
        assert(!vote(f, 3).some((packet) => packet.id === 9548))
        commit(f)
        assert.equal(f.room().target.dungeon_id, rows[0].dungeonId)
    } finally {
        f.store.close()
    }
})

test('authority comes from the real participant and connection, never optional target or a forged player field', () => {
    const f = teamFixture({ count: 4, account: 'vote-authority' })
    try {
        party(f)
        propose(f)
        assert.throws(() => vote(f, 4), code(ErrorCode.NotInMatchTeam))
        assert.throws(
            () => f.call(2, 'ReplyChangeDungeon', { accept: true, dungeon_id: rows[2].dungeonId }),
            code(ErrorCode.TeamTargetChanged),
        )
        const wrong = { ...f.sessions[1], token: 'not-the-bound-connection' }
        assert.throws(
            () =>
                f.game.dispatch(wrong, {
                    id: 9547,
                    seq: 50000,
                    payload: f.protocol.encode(f.protocol.byId.get(9547).req, { accept: true }),
                }),
            code(ErrorCode.TeamTargetChanged),
        )
        assert.throws(() => f.call(2, 'ReplyChangeDungeon', { accept: true, player_id: f.id(3) }), /Unknown field/)
        // Add a foreign varint field3 directly on the wire; the real schema
        // has no sender field and must still derive sender2 from the session.
        const extra = [0x18]
        let forged = f.id(3)
        do {
            const low = forged & 127
            forged >>>= 7
            extra.push(low | (forged ? 128 : 0))
        } while (forged)
        const packets = f.game.dispatch(f.sessions[1], {
            id: 9547,
            seq: 50001,
            payload: Buffer.concat([
                f.protocol.encode(f.protocol.byId.get(9547).req, { accept: true }),
                Buffer.from(extra),
            ]),
        })
        assert.equal(f.decode(packets.find((packet) => packet.id === 9548)).player_id, f.id(2))
        assert.equal(
            f.teams.changes.get(f.room().id).votes.some((entry) => entry.id === f.id(3)),
            false,
        )
    } finally {
        f.store.close()
    }
})

test('the final confirmation rechecks current table eligibility after all players have voted', () => {
    const f = teamFixture({ count: 3, account: 'final-eligibility' })
    try {
        for (let i = 1; i <= 3; i++)
            f.edit(i, (state) => {
                state.player.basic_info.lv = 15
            })
        party(f)
        const target = teamTables.get('dungeon_crisiscrusade').find((row) => row.taskUnlock === '2004#15')
        propose(f, target)
        vote(f, 2)
        vote(f, 3)
        f.edit(3, (state) => {
            state.player.basic_info.lv = 14
        })
        assert.throws(() => commit(f, target), code(ErrorCode.TeamTargetLevelNotMet))
        assert.equal(f.room().target.dungeon_id, rows[0].dungeonId)
        assert.equal(f.teams.changes.get(f.room().id).status, 'pending')
        f.edit(3, (state) => {
            state.player.basic_info.lv = 15
        })
        commit(f, target)
        assert.equal(f.room().target.dungeon_id, target.dungeonId)
    } finally {
        f.store.close()
    }
})

test('late votes at15s close once as expired and the normal client timeout-No after closure is harmless', () => {
    const f = teamFixture({ count: 3, account: 'late-target-vote' })
    try {
        party(f)
        propose(f)
        f.advance(15)
        const packets = vote(f, 2)
        assert.equal(f.teams.changes.get(f.room().id).status, 'expired')
        assert(!packets.some((packet) => packet.id === 9548))
        assert.equal(f.room().target.dungeon_id, rows[0].dungeonId)
        const saved = f.teams.changes.get(f.room().id)
        f.call(3, 'ReplyChangeDungeon', {})
        assert.deepEqual(f.teams.changes.get(f.room().id), saved)
    } finally {
        f.store.close()
    }
})

test('vote/cancel packet failures roll back a decision and a final peer-snapshot failure rolls back the target transition', () => {
    for (const [accept, broken] of [
        [true, 9548],
        [false, 9546],
    ]) {
        const f = teamFixture({ count: 3, account: 'vote-codec-' + broken }),
            original = f.protocol.encode.bind(f.protocol)
        try {
            party(f)
            propose(f)
            const pending = f.teams.changes.get(f.room().id)
            f.protocol.encode = (type, data) => {
                if (type === f.protocol.byId.get(broken).rsp) throw Error('isolated vote codec failure')
                return original(type, data)
            }
            assert.throws(() => vote(f, 2, accept), /isolated vote codec failure/)
            assert.deepEqual(f.teams.changes.get(f.room().id), pending)
            assert.equal(f.room().target.dungeon_id, rows[0].dungeonId)
        } finally {
            f.protocol.encode = original
            f.store.close()
        }
    }
    const f = teamFixture({ count: 3, account: 'final-codec' }),
        original = f.protocol.encode.bind(f.protocol)
    try {
        party(f)
        propose(f)
        vote(f, 2)
        vote(f, 3)
        const pending = f.teams.changes.get(f.room().id),
            room = f.room()
        let snapshots = 0
        f.protocol.encode = (type, data) => {
            if (type === f.protocol.byId.get(9520).rsp && ++snapshots === 2) throw Error('isolated final codec failure')
            return original(type, data)
        }
        assert.throws(() => commit(f), /isolated final codec failure/)
        assert.deepEqual(f.room(), room)
        assert.deepEqual(f.teams.changes.get(room.id), pending)
        f.protocol.encode = original
        commit(f)
        assert.equal(f.room().revision, room.revision + 1)
    } finally {
        f.protocol.encode = original
        f.store.close()
    }
})

test('real SQLite reopen invalidates the old participant connections and requires a fresh proposal and fresh decisions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-target-votes-')),
        database = path.join(directory, 'state.db'),
        stores = []
    try {
        const first = teamFixture({ database, count: 3, account: 'persisted-vote' })
        stores.push(first.store)
        party(first)
        propose(first)
        vote(first, 2)
        vote(first, 3)
        const old = first.teams.changes.get(first.room().id)
        first.store.close()
        const next = teamFixture({ database, count: 3, account: 'persisted-vote' })
        stores.push(next.store)
        commit(next)
        assert.equal(next.teams.changes.get(next.room().id).status, 'cancelled')
        assert.equal(next.room().target.dungeon_id, rows[0].dungeonId)
        propose(next)
        const current = next.teams.changes.get(next.room().id)
        assert(current.epoch > old.epoch)
        assert.deepEqual(current.votes, [{ id: next.id(1), accept: true }])
        vote(next, 2)
        vote(next, 3)
        commit(next)
        assert.equal(next.room().target.dungeon_id, rows[1].dungeonId)
    } finally {
        for (const store of stores) store.close()
        const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory))
        assert(
            relative &&
                !relative.startsWith('..') &&
                !path.isAbsolute(relative) &&
                path.basename(directory).startsWith('luruka-target-votes-'),
        )
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
