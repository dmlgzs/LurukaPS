import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import { teamFixture, teamTables } from './legacy-match-team-fixture.js'
const targets = teamTables.get('dungeon_crisiscrusade').filter((row) => row.taskUnlock === '2004#1')
assert(targets.length >= 3)
const code = (expected) => (error) => error.code === expected
function party(f, count = 2) {
    f.create(1, targets[0].dungeonId)
    for (let i = 2; i <= count; i++) {
        f.invite(1, i, i - 1)
        f.call(i, 'ReplyInviteJoin', { invite_id: String(f.room().id), is_accept: true })
    }
}
const propose = (f, index = 1, target = targets[1]) =>
    f.call(index, 'ChangeDungeon', { dungeon_id: target.dungeonId, scene_type: 12 })
const commit = (f, index = 1, target = targets[1]) =>
    f.game.dispatch(f.sessions[index - 1], {
        id: 9536,
        seq: 50000,
        payload: f.protocol.encode('cs.ChangeDungeonSync', { dungeon_id: target.dungeonId, ask: false }),
    })

test('single-member9536 changes only the actual room target and accepts the real client final message as an idempotent receipt', () => {
    const f = teamFixture({ count: 1, account: 'solo-change' })
    try {
        party(f, 1)
        const before = f.room(),
            world = f.state(1).world
        const packets = propose(f)
        assert(!packets.some((packet) => packet.id === 9536))
        const changed = f.decode(packets.find((packet) => packet.id === 9546))
        assert.deepEqual(changed, { dungeon_id: targets[1].dungeonId, ask: false, player_id: f.id(1), cancel: false })
        assert.equal(f.room().id, before.id)
        assert.equal(f.room().revision, before.revision + 1)
        assert.equal(f.room().target.kind, 'crisis')
        assert.equal(f.room().target.config_id, targets[1].id)
        assert.deepEqual(f.state(1).world, world)
        assert.equal(f.teams.changes.get(f.room().id).status, 'committed')
        const saved = f.room()
        assert(commit(f).some((packet) => packet.id === 9520))
        assert.deepEqual(f.room(), saved)
    } finally {
        f.store.close()
    }
})

test('multiplayer9536 creates one15s proposal with only the captain vote and cannot commit before actual decisions', () => {
    const f = teamFixture({ count: 3, account: 'pending-change' })
    try {
        party(f, 2)
        const before = f.room(),
            packets = propose(f),
            proposal = f.teams.changes.get(before.id)
        assert.equal(proposal.status, 'pending')
        assert.equal(proposal.expires_at - proposal.created_at, 15)
        assert.equal(proposal.room_revision, before.revision)
        assert.deepEqual(proposal.votes, [{ id: f.id(1), accept: true }])
        assert.deepEqual(
            proposal.participants.map((member) => member.id),
            [f.id(1), f.id(2)],
        )
        assert.deepEqual(f.room(), before)
        assert.deepEqual(
            packets
                .filter((packet) => packet.id === 9546)
                .map((packet) => packet.recipient ?? f.id(1))
                .sort(),
            [f.id(1), f.id(2)],
        )
        for (const packet of packets.filter((packet) => packet.id === 9546)) assert.equal(f.decode(packet).ask, true)
        assert.throws(() => commit(f), code(ErrorCode.TeamWaitStateSync))
        assert.throws(() => propose(f, 2), code(ErrorCode.IsNotMatchTeamLeader))
        assert.throws(() => commit(f, 2), code(ErrorCode.IsNotMatchTeamLeader))
        assert.throws(() => commit(f, 1, targets[2]), code(ErrorCode.TeamTargetChanged))
        f.advance(2)
        assert(!propose(f).some((packet) => packet.id === 9546), 'duplicate must not restart member dialogs')
        assert.deepEqual(f.teams.changes.get(before.id), proposal)
        assert.throws(() => propose(f, 1, targets[2]), code(ErrorCode.TeamWaitStateSync))
        assert.throws(() => f.invite(1, 3), code(ErrorCode.TeamWaitStateSync))
    } finally {
        f.store.close()
    }
})

test('proposal admission rechecks all real members and rejects locked/unknown targets or offline participants without allocating an epoch', () => {
    const f = teamFixture({ count: 2, account: 'invalid-change' })
    try {
        party(f)
        const locked = teamTables.get('dungeon_crisiscrusade').find((row) => row.taskUnlock === '2004#15')
        assert.throws(() => propose(f, 1, locked), code(ErrorCode.EntrustUnlock))
        f.edit(1, (state) => {
            state.player.basic_info.lv = 15
        })
        assert.throws(() => propose(f, 1, locked), code(ErrorCode.TeamTargetLevelNotMet))
        f.online.delete(f.id(2))
        assert.throws(() => propose(f), code(ErrorCode.PlayerNotOnline))
        f.online.add(f.id(2))
        assert.throws(
            () => f.call(1, 'ChangeDungeon', { dungeon_id: 0xffffffff, scene_type: 12 }),
            code(ErrorCode.DungeonConfNotExist),
        )
        assert.throws(
            () => f.call(1, 'ChangeDungeon', { dungeon_id: targets[1].dungeonId, scene_type: 22, dungeon_site: 1 }),
            code(ErrorCode.FunctionClosed),
        )
        assert.equal(f.teams.changes.get(f.room().id), null)
        assert.equal(
            f.store.db.prepare('SELECT value FROM sequences WHERE name=?').get('legacy-match-change'),
            undefined,
        )
    } finally {
        f.store.close()
    }
})

test('an indexed idle maintenance pass expires once at15s and restores the current target without player movement or account writes', () => {
    const f = teamFixture({ count: 2, account: 'expire-change' })
    try {
        party(f)
        propose(f)
        const before = f.room(),
            own = f.store.load(f.id(1)),
            peer = f.store.load(f.id(2))
        f.advance(14)
        assert.deepEqual(f.teams.changes.maintenance(f.time.now), [])
        f.advance(1)
        const packets = f.teams.changes.maintenance(f.time.now)
        assert.equal(packets.length, 2)
        for (const packet of packets)
            assert.deepEqual(f.decode(packet), {
                dungeon_id: targets[0].dungeonId,
                ask: false,
                player_id: f.id(1),
                cancel: false,
            })
        assert.equal(f.teams.changes.get(before.id).status, 'expired')
        assert.deepEqual(f.room(), before)
        assert.deepEqual(f.store.load(f.id(1)), own)
        assert.deepEqual(f.store.load(f.id(2)), peer)
        const changes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        assert.deepEqual(f.teams.changes.maintenance(f.time.now), [])
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes)
        assert(commit(f).some((packet) => packet.id === 9520))
        assert.deepEqual(f.room(), before)
    } finally {
        f.store.close()
    }
})

test('proposal creation and idle expiry packet failures roll back sequence, invitation cleanup and proposal state', () => {
    const f = teamFixture({ count: 3, account: 'change-codec' }),
        original = f.protocol.encode.bind(f.protocol)
    try {
        party(f)
        f.invite(1, 3)
        const offer = f.teams.invitationFor(f.id(3))
        f.protocol.encode = (type, data) => {
            if (type === f.protocol.byId.get(9546).rsp) throw Error('isolated change codec failure')
            return original(type, data)
        }
        assert.throws(() => propose(f), /isolated change codec failure/)
        assert.equal(f.teams.changes.get(f.room().id), null)
        assert.deepEqual(f.teams.invitationFor(f.id(3)), offer)
        assert.equal(
            f.store.db.prepare('SELECT value FROM sequences WHERE name=?').get('legacy-match-change'),
            undefined,
        )
        f.protocol.encode = original
        propose(f)
        assert.equal(f.teams.invitationFor(f.id(3)), null)
        const pending = f.teams.changes.get(f.room().id)
        f.advance(15)
        f.protocol.encode = (type, data) => {
            if (type === f.protocol.byId.get(9546).rsp) throw Error('isolated expiry codec failure')
            return original(type, data)
        }
        assert.throws(() => f.teams.changes.maintenance(f.time.now), /isolated expiry codec failure/)
        assert.deepEqual(f.teams.changes.get(f.room().id), pending)
        f.protocol.encode = original
        f.teams.changes.maintenance(f.time.now)
        assert.equal(f.teams.changes.get(f.room().id).status, 'expired')
    } finally {
        f.protocol.encode = original
        f.store.close()
    }
})

test('a real leave cancels the bound roster proposal and a reconnect cannot finalize its old connection epoch', () => {
    const f = teamFixture({ count: 2, account: 'cancel-change' })
    try {
        party(f)
        propose(f)
        const id = f.room().id
        f.call(2, 'LeaveMatchTeam')
        assert.equal(f.teams.changes.get(id).status, 'cancelled')
        assert.equal(f.room().target.dungeon_id, targets[0].dungeonId)
        f.invite(1, 2)
        f.call(2, 'ReplyInviteJoin', { invite_id: String(id), is_accept: true })
        propose(f)
        f.relog(2)
        const packets = commit(f)
        assert(
            packets.some(
                (packet) =>
                    packet.id === 9546 &&
                    f.decode(packet).dungeon_id === targets[0].dungeonId &&
                    f.decode(packet).ask === false,
            ),
        )
        assert.equal(f.teams.changes.get(id).status, 'cancelled')
        assert.equal(f.room().target.dungeon_id, targets[0].dungeonId)
    } finally {
        f.store.close()
    }
})
