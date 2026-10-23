import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import { teamFixture, teamMaterial, teamTables } from './legacy-match-team-fixture.js'
const code = (expected) => (error) => error.code === expected

test('9525 saves a real recipient-bound30s offer, pushes9521 to that account without ACK or auto-joining, and leaves peer state unchanged', () => {
    const f = teamFixture()
    try {
        f.create()
        const peer = f.store.load(f.id(2)),
            packets = f.invite(1, 2),
            room = f.room()
        assert(!packets.some((packet) => packet.id === 9525))
        const packet = packets.find((packet) => packet.id === 9521)
        assert.equal(packet.recipient, f.id(2))
        assert.deepEqual(f.decode(packet), {
            invite: {
                pid: f.id(1),
                team_id: String(room.id),
                dungeon_id: teamMaterial.dungeonId,
                name: Buffer.from(f.state(1).player.basic_info.name, 'base64').toString('utf8'),
                scene_type: 12,
                cancel: false,
            },
        })
        const offer = f.teams.invitationFor(f.id(2))
        assert.equal(offer.recipient_id, f.id(2))
        assert.equal(offer.inviter_id, f.id(1))
        assert.equal(offer.expires_at - offer.created_at, 30)
        assert.deepEqual(offer.target, room.target)
        assert.equal(offer.status, 'pending')
        assert.equal(f.room(2), null)
        assert.deepEqual(f.store.load(f.id(2)), peer)
    } finally {
        f.store.close()
    }
})

test('invitation admission checks shape, actual room target, online connection, blacklist and active-dungeon state', () => {
    const f = teamFixture()
    try {
        f.create()
        const request = { pid: f.id(2), position: 1, dungeon_id: teamMaterial.dungeonId }
        for (const [value, expected] of [
            [{ ...request, pid: 0 }, ErrorCode.ReqParamsError],
            [{ ...request, position: 3 }, ErrorCode.ReqParamsError],
            [{ ...request, pid: f.id(1) }, ErrorCode.CannotOptYourSelf],
            [{ ...request, pid: 0xffffffff }, ErrorCode.InvalidTarget],
            [{ ...request, dungeon_id: 0xffffffff }, ErrorCode.TeamTargetChanged],
            [{ ...request, is_quit: true }, ErrorCode.FunctionClosed],
        ])
            assert.throws(() => f.call(1, 'InviteJoin', value), code(expected))
        assert.throws(() => f.call(3, 'InviteJoin', request), code(ErrorCode.NotInMatchTeam))
        f.online.delete(f.id(2))
        assert.throws(() => f.invite(1, 2), code(ErrorCode.PlayerNotOnline))
        f.online.add(f.id(2))
        f.edit(1, (state) => {
            state.blockedPlayers = [f.id(2)]
        })
        assert.throws(() => f.invite(1, 2), code(ErrorCode.YouBanTarget))
        f.edit(1, (state) => {
            state.blockedPlayers = []
        })
        f.edit(2, (state) => {
            state.blockedPlayers = [f.id(1)]
        })
        assert.throws(() => f.invite(1, 2), code(ErrorCode.TargetBanYou))
        f.edit(2, (state) => {
            state.blockedPlayers = []
            state.storyCampaign = { isolated_fixture: true }
        })
        assert.throws(() => f.invite(1, 2), code(ErrorCode.TargetBusy))
        f.edit(2, (state) => {
            delete state.storyCampaign
        })
        assert.equal(f.teams.invitationFor(f.id(2)), null)
        f.create(2)
        assert.throws(() => f.invite(1, 2), code(ErrorCode.InvitedMemberInMatchTeam))
    } finally {
        f.store.close()
    }
})

test('peer eligibility distinguishes actual table level failure from prerequisite clear failure', () => {
    const f = teamFixture()
    try {
        const locked = teamTables.get('dungeon_material').find((row) => row.unlock.startsWith('2004#15|13112#'))
        assert(locked)
        const prior = Number(locked.unlock.split('|')[1].split('#')[1])
        const unlock = (state) => {
            state.player.basic_info.lv = 15
            state.materialDungeonRecords = {
                [prior]: {
                    material_id: prior,
                    material_star: 0,
                    success_count: 1,
                    success_time: String(f.time.now),
                    difficulty_id: 1,
                },
            }
        }
        f.edit(1, unlock)
        f.create(1, locked.dungeonId)
        assert.throws(() => f.invite(1, 2), code(ErrorCode.TeamTargetLevelNotMet))
        f.edit(2, (state) => {
            state.player.basic_info.lv = 15
        })
        assert.throws(() => f.invite(1, 2), code(ErrorCode.TargetUnlockSystem))
        f.edit(2, unlock)
        assert(f.invite(1, 2).some((packet) => packet.id === 9521))
    } finally {
        f.store.close()
    }
})

test('duplicate offers preserve expiry and do not restart UI; capacity reservations and competing rooms are serialized', () => {
    const f = teamFixture()
    try {
        f.create()
        f.create(4)
        f.invite(1, 2)
        const before = f.teams.invitationFor(f.id(2))
        f.advance(5)
        assert(!f.invite(1, 2).some((packet) => packet.id === 9521))
        assert.deepEqual(f.teams.invitationFor(f.id(2)), before)
        assert.throws(() => f.invite(4, 2), code(ErrorCode.TargetBeingInvited))
        f.invite(1, 3, 2)
        assert.throws(() => f.invite(1, 5), code(ErrorCode.InviteMatchTeamNumLimit))
        f.advance(25)
        f.invite(1, 5)
        assert.equal(f.teams.invitationFor(f.id(5)).expires_at, f.time.now + 30)
        f.invite(4, 2)
        assert.equal(f.teams.invitationFor(f.id(2)).room_id, f.room(4).id)
    } finally {
        f.store.close()
    }
})

test('bad policy and9521 encoding failure preserve receipts, room state and both accounts atomically', () => {
    const f = teamFixture(),
        original = f.protocol.encode.bind(f.protocol)
    try {
        f.create()
        f.teams.policy.expected_client_window_seconds = 31
        assert.throws(() => f.invite(1, 2), code(ErrorCode.GameConfig))
        assert.equal(f.teams.invitationFor(f.id(2)), null)
        f.teams.policy.expected_client_window_seconds = 30
        f.invite(1, 2)
        const receipt = f.teams.invitationFor(f.id(2))
        f.advance(31)
        const own = f.store.load(f.id(1)),
            peer = f.store.load(f.id(2)),
            room = f.room()
        f.protocol.encode = (type, value) => {
            if (type === f.protocol.byId.get(9521).rsp) throw Error('isolated invitation notification failure')
            return original(type, value)
        }
        assert.throws(() => f.invite(1, 2), /isolated invitation notification failure/)
        assert.deepEqual(f.teams.invitationFor(f.id(2)), receipt)
        assert.deepEqual(f.room(), room)
        assert.deepEqual(f.store.load(f.id(1)), own)
        assert.deepEqual(f.store.load(f.id(2)), peer)
        f.protocol.encode = original
        f.invite(1, 2)
        assert.equal(f.teams.invitationFor(f.id(2)).expires_at, f.time.now + 30)
    } finally {
        f.protocol.encode = original
        f.store.close()
    }
})

test('room changes and recipient relog invalidate old offers instead of replaying an incorrect30s countdown', () => {
    const f = teamFixture()
    try {
        f.create()
        f.create(3)
        f.invite(1, 2)
        f.call(1, 'LeaveMatchTeam')
        assert.equal(f.teams.invitationFor(f.id(2)), null)
        f.invite(3, 2)
        f.relog(2)
        assert.equal(f.teams.invitationFor(f.id(2)), null)
        f.invite(3, 2)
        assert.equal(f.teams.invitationFor(f.id(2)).room_id, f.room(3).id)
    } finally {
        f.store.close()
    }
})
