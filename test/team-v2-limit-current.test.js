import test from 'node:test'
import assert from 'node:assert/strict'
import { targetFixture, protocol } from './team-v2-target-change-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('current captain limit update reaches members,persists and gates a later invite without changing the roster', () => {
    const f = targetFixture({ count: 3 })
    try {
        f.store.transact(f.id(2), 0, (state) => {
            state.player.basic_info.lv = 35
        })
        f.create(2)
        const before = structuredClone(f.room()),
            peer = f.store.playerById.get(f.id(1))
        const request = { team_id: before.id, team_limit: { level: 40 } }
        const packets = f.call(0, 'TeamV2UpdateLimit', request)
        assert.equal(protocol.byName.get('CSProtoTeamV2UpdateLimit').rsp, undefined)
        assert(
            !packets.some((packet) => packet.id === 11858),
            'The current no-response request completes through reason10,not a fabricated typed ACK',
        )
        const notices = packets
            .filter((packet) => packet.id === 11823)
            .map((packet) => ({
                recipient: packet.recipient ?? f.id(0),
                data: protocol.decode(protocol.byId.get(11823).rsp, packet.payload),
            }))
        assert.deepEqual(
            notices.map((row) => row.recipient).sort((a, b) => a - b),
            [f.id(0), f.id(1)],
        )
        // Current UpdateSTeam reason10 feeds MultiComTeamManager's local
        // level setting;it is not one of the full team replacement reasons.
        assert(notices.every((row) => row.data.reason === 10 && row.data.team.limit.level === 40))
        assert.deepEqual(f.room().members, before.members)
        assert.deepEqual(f.room().target, before.target)
        assert.equal(f.room().state, 1)
        assert.equal(f.room().revision, before.revision + 1)
        assert.equal(
            JSON.parse(
                f.store.db.prepare('SELECT payload FROM team_v2_rooms WHERE id=?').get(Number(before.id)).payload,
            ).limit.level,
            40,
        )
        assert.deepEqual(f.store.playerById.get(f.id(1)), peer, 'Publishing a setting must not save a peer profile')
        assert.throws(
            () => f.call(1, 'TeamV2UpdateLimit', { ...request, team_limit: { level: 20 } }),
            (error) => error.code === ErrorCode.IsNotMatchTeamLeader,
        )
        assert.throws(
            () => f.call(0, 'TeamV2InviteJoinTeam', { team_id: before.id, player_id: f.id(2) }),
            (error) => error.code === ErrorCode.TeamMemberLevelNotMet,
        )
        const revision = f.room().revision
        f.call(0, 'TeamV2UpdateLimit', request)
        assert.equal(f.room().revision, revision)
        assert.equal(f.room().members.length, 2)
    } finally {
        f.close()
    }
})
