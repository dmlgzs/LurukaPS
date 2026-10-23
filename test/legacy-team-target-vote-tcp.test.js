import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import { legacyTeamTCP } from './legacy-team-tcp-fixture.js'

test('real TCP captain aggregates9548, sends the client final9536 only after real votes, and a default-No closes the next proposal', async () => {
    const f = await legacyTeamTCP()
    try {
        const {
                members: [captain, b, c],
                room,
            } = await f.party(3),
            members = [captain, b, c]
        const accepted = new Set([captain.id])
        captain.send('ChangeDungeon', { dungeon_id: f.targets[1].dungeonId, scene_type: 12 })
        for (const member of members) assert.equal(f.decode(await member.next(9546)).ask, true)
        b.send('ReplyChangeDungeon', { accept: true })
        const first = f.decode(await captain.next(9548))
        assert.deepEqual(first, { player_id: b.id, accept: true })
        accepted.add(first.player_id)
        assert.equal(accepted.size, 2)
        captain.commit(f.targets[1].dungeonId)
        assert.equal((await captain.next(9536)).error, ErrorCode.TeamWaitStateSync)
        assert.equal(f.server.game.legacyMatchTeams.roomFor(captain.id).target.dungeon_id, f.targets[0].dungeonId)
        c.send('ReplyChangeDungeon', { accept: true })
        const last = f.decode(await captain.next(9548))
        accepted.add(last.player_id)
        assert.equal(accepted.size, 3)
        assert.equal(
            b.queue.some((frame) => frame.id === 9548),
            false,
        )
        assert.equal(
            c.queue.some((frame) => frame.id === 9548),
            false,
        )
        // Same aggregation branch as MultiTeamStore.RspAcceptLevelChange:
        // the captain now emits ChangeDungeonSync(ask=false) on9536.
        captain.commit(f.targets[1].dungeonId)
        for (const member of members) {
            assert.deepEqual(f.decode(await member.next(9546)), {
                dungeon_id: f.targets[1].dungeonId,
                ask: false,
                player_id: captain.id,
                cancel: false,
            })
            assert.equal(f.decode(await member.next(9520)).team.dungeon_id, f.targets[1].dungeonId)
        }
        assert.equal(f.server.game.legacyMatchTeams.changes.get(room.team_id).status, 'committed')
        captain.send('ChangeDungeon', { dungeon_id: f.targets[2].dungeonId, scene_type: 12 })
        for (const member of members) assert.equal(f.decode(await member.next(9546)).ask, true)
        b.send('ReplyChangeDungeon')
        assert.deepEqual(f.decode(await captain.next(9548)), { player_id: b.id, accept: false })
        for (const member of members)
            assert.deepEqual(f.decode(await member.next(9546)), {
                dungeon_id: f.targets[1].dungeonId,
                ask: false,
                player_id: captain.id,
                cancel: false,
            })
        c.send('ReplyChangeDungeon', { accept: true })
        c.send('Heartbeat', { client_time: { time: '2' } })
        assert.equal((await c.next(5002)).error, 0)
        assert.equal(
            c.queue.some((frame) => frame.id === 9547 && frame.error),
            false,
        )
        assert.equal(f.server.game.legacyMatchTeams.changes.get(room.team_id).status, 'declined')
        assert.equal(f.server.game.legacyMatchTeams.roomFor(captain.id).target.dungeon_id, f.targets[1].dungeonId)
        assert(!f.warnings.some((line) => line.includes('Unsupported') || line.includes('not implemented')))
    } finally {
        await f.close()
    }
})
