import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import { legacyMatchTarget } from '../src/legacy-match-teams.js'
import { teamFixture, teamTables, teamMaterial } from './legacy-match-team-fixture.js'
const rows = teamTables.get('dungeon_crisiscrusade')
const code = (expected) => (error) => error.code === expected

test('every current crisis target is admitted from its actual row without aliasing material IDs or teleporting the player', () => {
    const f = teamFixture({ count: 1, account: 'all-crisis' })
    try {
        assert(rows.length > 0)
        f.edit(1, (state) => {
            state.player.basic_info.lv = Math.max(...teamTables.get('player_level').map((row) => row.id))
        })
        const position = structuredClone(f.state(1).world)
        for (const row of rows) {
            assert(teamTables.find('dungeon', row.dungeonId))
            const packets = f.create(1, row.dungeonId),
                room = f.room()
            assert.equal(room.target.kind, 'crisis')
            assert.equal(room.target.config_id, row.id)
            assert.equal(room.target.dungeon_id, row.dungeonId)
            assert.equal(f.decode(packets.find((packet) => packet.id === 9520)).team.dungeon_id, row.dungeonId)
            assert.deepEqual(f.state(1).world, position)
            assert.equal(f.state(1).entrust?.run, undefined, 'lobby target selection must not invent a battle')
            f.call(1, 'LeaveMatchTeam')
        }
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_rooms').get().n, 0)
    } finally {
        f.store.close()
    }
})

test('all crisis level bands enforce taskUnlock rather than the recommended level or row ID', () => {
    const f = teamFixture({ count: 1, account: 'crisis-levels' })
    try {
        for (const row of new Map(rows.map((row) => [row.taskUnlock, row])).values()) {
            const required = Number(row.taskUnlock.split('#')[1])
            if (required > 1) {
                f.edit(1, (state) => {
                    state.player.basic_info.lv = required - 1
                })
                assert.throws(() => f.create(1, row.dungeonId), code(ErrorCode.EntrustUnlock))
                assert.equal(f.room(), null)
            }
            f.edit(1, (state) => {
                state.player.basic_info.lv = required
            })
            f.create(1, row.dungeonId)
            assert.equal(f.room().target.config_id, row.id)
            f.call(1, 'LeaveMatchTeam')
        }
    } finally {
        f.store.close()
    }
})

test('real crisis invitations and replies use the crisis configuration for both initial and changed player eligibility', () => {
    const f = teamFixture({ count: 3, account: 'crisis-join' })
    try {
        const row = rows.find((row) => row.taskUnlock === '2004#15')
        assert(row)
        f.edit(1, (state) => {
            state.player.basic_info.lv = 15
        })
        f.create(1, row.dungeonId)
        assert.throws(() => f.invite(1, 2), code(ErrorCode.TeamTargetLevelNotMet))
        f.edit(2, (state) => {
            state.player.basic_info.lv = 15
        })
        f.invite(1, 2)
        f.edit(2, (state) => {
            state.player.basic_info.lv = 14
        })
        assert.throws(
            () => f.call(2, 'ReplyInviteJoin', { invite_id: String(f.room().id), is_accept: true }),
            code(ErrorCode.TeamTargetLevelNotMet),
        )
        assert.equal(f.room(2), null)
        f.edit(2, (state) => {
            state.player.basic_info.lv = 15
        })
        const packets = f.call(2, 'ReplyInviteJoin', { invite_id: String(f.room().id), is_accept: true })
        assert.deepEqual(f.room(2).target, f.room().target)
        assert.equal(f.room(2).target.kind, 'crisis')
        assert.equal(f.decode(packets.find((packet) => packet.id === 9520)).team.dungeon_id, row.dungeonId)
    } finally {
        f.store.close()
    }
})

test('configuration collisions, missing dungeon bindings and unsupported crisis conditions remain explicit errors', () => {
    const f = teamFixture({ count: 1, account: 'crisis-config' })
    try {
        const row = rows[0],
            base = teamTables
        const context = (tables) => ({ state: f.state(1), tables, activityCatalog: f.game.activities })
        const proxy = (get, find) => ({
            get: get ?? ((name) => base.get(name)),
            find: find ?? ((name, id) => base.find(name, id)),
        })
        const collide = proxy((name) =>
            name === 'dungeon_crisiscrusade'
                ? [...rows, { ...row, dungeonId: teamMaterial.dungeonId }]
                : base.get(name),
        )
        assert.throws(
            () => legacyMatchTarget(context(collide), { dungeon_id: teamMaterial.dungeonId, scene_type: 12 }),
            code(ErrorCode.GameConfig),
        )
        const absent = proxy(undefined, (name, id) =>
            name === 'dungeon' && id === row.dungeonId ? undefined : base.find(name, id),
        )
        assert.throws(
            () => legacyMatchTarget(context(absent), { dungeon_id: row.dungeonId, scene_type: 12 }),
            code(ErrorCode.DungeonConfNotExist),
        )
        const unsupported = proxy((name) =>
            name === 'dungeon_crisiscrusade'
                ? rows.map((candidate) =>
                      candidate.id === row.id ? { ...candidate, taskUnlock: '999999#1' } : candidate,
                  )
                : base.get(name),
        )
        assert.throws(
            () => legacyMatchTarget(context(unsupported), { dungeon_id: row.dungeonId, scene_type: 12 }),
            code(ErrorCode.FunctionClosed),
        )
        assert.equal(f.room(), null)
    } finally {
        f.store.close()
    }
})
