import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyTeamTCP } from './legacy-team-tcp-fixture.js'

test('real TCP target proposals expire on the idle scheduler and disconnect cancels the bound participants', async () => {
    const f = await legacyTeamTCP()
    try {
        const {
            members: [captain, peer],
            room,
        } = await f.party()
        captain.send('ChangeDungeon', { dungeon_id: f.targets[1].dungeonId, scene_type: 12 })
        for (const member of [captain, peer]) assert.equal(f.decode(await member.next(9546)).ask, true)
        assert.equal(f.server.game.legacyMatchTeams.roomFor(captain.id).target.dungeon_id, f.targets[0].dungeonId)
        f.time.now += 15
        for (const member of [captain, peer])
            assert.deepEqual(f.decode(await member.next(9546)), {
                dungeon_id: f.targets[0].dungeonId,
                ask: false,
                player_id: captain.id,
                cancel: true,
            })
        assert.equal(f.server.game.legacyMatchTeams.changes.get(room.team_id).status, 'expired')
        captain.send('ChangeDungeon', { dungeon_id: f.targets[1].dungeonId, scene_type: 12 })
        for (const member of [captain, peer]) assert.equal(f.decode(await member.next(9546)).ask, true)
        const closed = new Promise((resolve) => peer.socket.once('close', resolve))
        peer.socket.destroy()
        await closed
        assert.equal(f.decode(await captain.next(9546)).cancel, true)
        assert.equal(f.decode(await captain.next(9561)).status, 1)
        assert.equal(f.server.game.legacyMatchTeams.changes.get(room.team_id).status, 'cancelled')
        assert.equal(f.server.game.legacyMatchTeams.roomFor(captain.id).target.dungeon_id, f.targets[0].dungeonId)
        assert(!f.warnings.some((line) => line.includes('proposal maintenance') || line.includes('presence omitted')))
    } finally {
        await f.close()
    }
})
