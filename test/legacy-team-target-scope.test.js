import test from 'node:test'
import assert from 'node:assert/strict'
import { teamFixture, teamTables } from './legacy-match-team-fixture.js'
const targets = teamTables.get('dungeon_crisiscrusade').filter((row) => row.taskUnlock === '2004#1')
function setup() {
    const f = teamFixture({ count: 2, account: 'notification-scope' })
    f.create(1, targets[0].dungeonId)
    f.invite(1, 2)
    f.call(2, 'ReplyInviteJoin', { invite_id: String(f.room().id), is_accept: true })
    f.call(1, 'ChangeDungeon', { dungeon_id: targets[1].dungeonId, scene_type: 12 })
    return f
}
for (const cause of ['decline', 'idle-expiry', 'disconnect', 'leave', 'late-final']) {
    test('legacy target ' + cause + ' keeps its real old target without the shared arena cancel flag', () => {
        const f = setup()
        try {
            const id = f.room().id
            let packets, status
            if (cause === 'decline' || cause === 'late-final') {
                packets = f.call(2, 'ReplyChangeDungeon', {})
                status = 'declined'
                if (cause === 'late-final')
                    packets = f.game.dispatch(f.sessions[0], {
                        id: 9536,
                        seq: 60000,
                        payload: f.protocol.encode('cs.ChangeDungeonSync', {
                            dungeon_id: targets[1].dungeonId,
                            ask: false,
                        }),
                    })
            } else if (cause === 'idle-expiry') {
                f.advance(15)
                packets = f.teams.changes.maintenance(f.time.now)
                status = 'expired'
            } else if (cause === 'disconnect') {
                f.online.delete(f.id(2))
                packets = f.teams.changes.maintenance(f.time.now, id)
                status = 'cancelled'
            } else {
                packets = f.call(2, 'LeaveMatchTeam')
                status = 'cancelled'
            }
            const notices = packets.filter((packet) => packet.id === 9546)
            assert(notices.length > 0)
            for (const packet of notices) {
                const data = f.decode(packet)
                assert.equal(data.dungeon_id, targets[0].dungeonId)
                assert.equal(data.ask, false)
                assert.equal(data.player_id, f.id(1))
                // Current MultiTeamStore uses only target+ask. Current
                // KiboArenaStore treats cancel=true as a dispatch override
                // even when there is no matching arena opponent.
                assert.equal(data.cancel, false, 'legacy closure must not assert the arena-specific cancel override')
            }
            assert.equal(f.teams.changes.get(id).status, status)
            assert.equal(f.room().target.dungeon_id, targets[0].dungeonId)
        } finally {
            f.store.close()
        }
    })
}
