import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ErrorCode } from '../src/error-codes.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { targetFixture } from './team-v2-target-change-fixture.js'

test('current11839/11841 changes the typed target only after all actual members accept, without entering any dungeon', () => {
    const f = targetFixture()
    try {
        f.create()
        const before = [0, 1, 2].map((who) => structuredClone(f.state(who))),
            initial = f.room()
        const proposed = f.propose()
        assert(!proposed.some((packet) => packet.id === 11839))
        assert.equal(f.room().target.dungeon_system_id, 10101)
        assert.deepEqual(f.room().change_vote, [f.id(0)])
        assert.equal(f.models.get(f.id(1)).dialog.target, 10201)
        assert.equal(f.models.get(f.id(1)).dialog.deadline, (f.now() + 30) * 1000)
        f.vote(1)
        assert.equal(f.room().target.dungeon_system_id, 10101)
        assert.deepEqual(f.models.get(f.id(0)).team.change_vote, [f.id(0), f.id(1)])
        const final = f.vote(2)
        assert(!final.some((packet) => [11841, 9510, 9567, 9103].includes(packet.id)))
        assert.equal(f.room().id, initial.id)
        assert.equal(f.room().target.dungeon_system_id, 10201)
        for (const who of [0, 1, 2]) {
            assert.equal(f.models.get(f.id(who)).team.target.dungeon_system_id, 10201)
            assert.equal(f.models.get(f.id(who)).outcome.reason, 13)
            assert.equal(f.models.get(f.id(who)).dialog, null)
            assert.deepEqual(f.state(who), before[who])
        }
    } finally {
        f.close()
    }
})

const code = (expected) => (error) => error.code === expected
const dump = (f) => ({
    players: f.sessions.map((session) => f.store.load(session.id)),
    rooms: f.store.db.prepare('SELECT * FROM team_v2_rooms ORDER BY id').all(),
    proposals: f.store.db.prepare('SELECT * FROM team_v2_target_changes ORDER BY team_id').all(),
    sequences: f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
})

test('a real ordinary member projection update may advance room revision without invalidating the same proposal authority', () => {
    const f = targetFixture({ count: 2 })
    try {
        f.create()
        f.propose()
        const room = f.room(),
            proposal = f.game.teamV2.changes.get(room.id)
        // Explicit valid public-name checkpoint, then the actual ordinary
        // observer publishes it. No membership, connection or target is edited.
        f.store.transact(f.id(1), 0, (state) => {
            state.player.basic_info.name = Buffer.from('新的展示名字').toString('base64')
        })
        f.call(1, 'WorldTimeSync', { world_time: 123 })
        assert(f.room().revision > room.revision)
        assert.equal(f.game.teamV2.changes.get(room.id).epoch, proposal.epoch)
        assert.equal(f.game.teamV2.changes.get(room.id).status, 'pending')
        f.vote(1)
        assert.equal(f.room().target.dungeon_system_id, 10201)
    } finally {
        f.close()
    }
})

test('weekly and crisis target changes retain their actual current campaign family and use eligible system-row IDs', () => {
    for (const [typ, table] of [
        [500, 'dungeon_weekly'],
        [1, 'dungeon_crisiscrusade'],
    ]) {
        const f = targetFixture({ count: 2 })
        try {
            if (typ === 500) {
                // Explicit old first-weekly one-star checkpoint for its current
                // 13117 next-difficulty gate; no new victory is claimed here.
                const route = getEntrustCatalog(f.tables).get(101, 'weekly')
                for (const who of [0, 1])
                    f.store.transact(f.id(who), 0, (state) => {
                        ;(state.weeklyDungeonRecords ??= {})[101] = {
                            weekly_id: 101,
                            dungeon_id: route.dungeon.id,
                            map_id: route.scene.id,
                            star: 1,
                            success_count: 1,
                            success_time: String(f.now() - 1),
                            clearance_time: '1000',
                        }
                    })
            }
            const eligible = f.tables.get(table).filter((row) => {
                for (const who of [0, 1]) {
                    try {
                        f.game.teamV2.requireTarget(
                            { tables: f.tables, state: f.state(who), id: f.id(who) },
                            { typ, target: { dungeon_system_id: row.id } },
                            f.id(who),
                            f.state(who),
                        )
                    } catch (error) {
                        if ([ErrorCode.SystemLock, ErrorCode.EntrustUnlock].includes(error.code)) return false
                        throw error
                    }
                }
                return true
            })
            assert(eligible.length >= 2, 'each current family needs two genuinely eligible rows')
            f.create(2, { typ, target: eligible[0].id })
            f.propose(eligible[1].id)
            f.vote(1)
            assert.equal(f.room().typ, typ)
            assert.equal(f.room().target.dungeon_system_id, eligible[1].id)
            assert.equal(f.models.get(f.id(1)).team.target.dungeon_system_id, eligible[1].id)
            assert.equal(f.state(0).entrust.run, undefined)
            assert.equal(f.state(1).entrust.run, undefined)
        } finally {
            f.close()
        }
    }
})

test('single-member changes commit immediately; pending proposal and vote retries cannot restart time or reverse decisions', () => {
    const f = targetFixture({ count: 2 })
    try {
        f.create(1)
        f.propose()
        assert.equal(f.room().target.dungeon_system_id, 10201)
        assert.equal(f.game.teamV2.changes.get(f.room().id).status, 'committed')
        const saved = structuredClone(f.room())
        f.propose()
        assert.deepEqual(f.room(), saved)
        f.call(0, 'TeamV2InviteJoinTeam', { team_id: saved.id, player_id: f.id(1) })
        f.call(1, 'TeamV2ReplyInviteJoin', { team_id: saved.id, player_id: f.id(1), is_accept: true })
        f.propose(10301)
        const pending = structuredClone(f.game.teamV2.changes.get(saved.id)),
            revision = f.room().revision
        f.advance(1)
        const repeat = f.propose(10301)
        assert.deepEqual(f.game.teamV2.changes.get(saved.id), pending)
        assert.equal(f.room().revision, revision)
        assert(!repeat.some((packet) => packet.recipient))
        assert(
            !repeat.some(
                (packet) => f.protocol.decode(f.protocol.byId.get(packet.id).rsp, packet.payload).reason === 11,
            ),
        )
        f.vote(1)
        const committed = structuredClone(f.room())
        f.vote(1, false)
        assert.deepEqual(f.room(), committed)
        assert.equal(f.room().target.dungeon_system_id, 10301)
    } finally {
        f.close()
    }
})

test('refusal and current table deadline retain the old target; idle maintenance does not write or extend a window', () => {
    const f = targetFixture({ count: 2 })
    try {
        f.create()
        f.propose()
        f.vote(1, false)
        assert.equal(f.game.teamV2.changes.get(f.room().id).status, 'declined')
        assert.equal(f.room().target.dungeon_system_id, 10101)
        assert.equal(f.models.get(f.id(0)).outcome.reason, 14)
        assert.equal(f.models.get(f.id(0)).outcome.player_id, f.id(1))
        f.propose()
        const pending = f.game.teamV2.changes.get(f.room().id)
        assert.equal(pending.window_ms, 30000)
        assert.equal(pending.expires_at_ms, pending.created_at_ms + 30000)
        f.advance(29)
        const changes = () => f.store.db.prepare('SELECT total_changes() AS n').get().n
        const writes = changes()
        assert.deepEqual(f.game.teamV2.changes.maintenance(f.now()), [])
        assert.equal(changes(), writes)
        f.advance(1)
        f.consume(0, f.game.teamV2.changes.maintenance(f.now()))
        assert.equal(f.game.teamV2.changes.get(f.room().id).status, 'expired')
        assert.equal(f.room().change_target, undefined)
        assert.equal(f.room().target.dungeon_system_id, 10101)
        assert.equal(f.models.get(f.id(1)).dialog, null)
        const doneWrites = changes(),
            done = structuredClone(f.room())
        assert.deepEqual(f.game.teamV2.changes.maintenance(f.now()), [])
        assert.equal(changes(), doneWrites)
        f.vote(1)
        assert.deepEqual(f.room(), done)
    } finally {
        f.close()
    }
})

test('actual target gates, captain/member/connection authority and invalid configuration reject atomically', () => {
    const f = targetFixture()
    try {
        f.create(2)
        for (const [action, expected] of [
            [() => f.propose(10201, 1), ErrorCode.IsNotMatchTeamLeader],
            [
                () => f.call(2, 'TeamV2VoteChangeTarget', { team_id: f.room().id, accept: true }),
                ErrorCode.NotInMatchTeam,
            ],
            [() => f.propose(10102), ErrorCode.EntrustUnlock], // current13112 requires an actual prior clear
            [() => f.propose(0xffffffff), ErrorCode.DungeonConfNotExist],
            [
                () =>
                    f.call(0, 'TeamV2StartChangeTarget', {
                        team_id: f.room().id,
                        target: { dungeon_system_id: 10201, dungeon_end_time: '1' },
                    }),
                ErrorCode.ReqParamsError,
            ],
        ]) {
            const before = dump(f)
            assert.throws(action, code(expected))
            assert.deepEqual(dump(f), before)
        }
        const get = f.tables.get
        try {
            f.tables.get = function (name, ...args) {
                const rows = get.call(this, name, ...args)
                return name === 'game'
                    ? rows.map((row) => (row.title === 'MULTI_CHANGE_TARGET_CD' ? { ...row, value: 'broken' } : row))
                    : rows
            }
            const before = dump(f)
            assert.throws(() => f.propose(), code(ErrorCode.GameConfig))
            assert.deepEqual(dump(f), before)
        } finally {
            f.tables.get = get
        }
        f.store.db.prepare('INSERT INTO sequences(name,value)VALUES(?,?)').run('team_v2_change', 0xffffffff)
        const exhausted = dump(f)
        assert.throws(() => f.propose(), code(ErrorCode.GameConfig))
        assert.deepEqual(dump(f), exhausted)
        f.store.db.prepare('DELETE FROM sequences WHERE name=?').run('team_v2_change')
        f.sessions[1].entered = false
        assert.throws(() => f.propose(), code(ErrorCode.PlayerNotOnline))
    } finally {
        f.close()
    }
})

test('the last acceptance rechecks real current clear eligibility and reports a member check failure without changing target', () => {
    const f = targetFixture()
    try {
        f.create()
        // Explicit historical zero-star clear checkpoint accepted by current
        // MaterialStarFinishCond; this is a qualification model, not a new win.
        for (let who = 0; who < 3; who++)
            f.store.transact(f.id(who), 0, (state) => {
                ;(state.materialDungeonRecords ??= {})[10101] = {
                    material_id: 10101,
                    material_star: 0,
                    success_time: String(f.now() - 1),
                    difficulty_id: 1,
                    success_count: 1,
                }
            })
        f.propose(10102)
        f.vote(1)
        f.store.transact(f.id(1), 0, (state) => {
            delete state.materialDungeonRecords[10101]
        })
        f.vote(2)
        assert.equal(f.room().target.dungeon_system_id, 10101)
        assert.equal(f.game.teamV2.changes.get(f.room().id).status, 'check_failed')
        for (const who of [0, 1, 2]) {
            assert.equal(f.models.get(f.id(who)).outcome.reason, 15)
            assert.deepEqual(f.models.get(f.id(who)).outcome.check_list, [
                { player_id: f.id(1), code: ErrorCode.EntrustUnlock },
            ])
        }
    } finally {
        f.close()
    }
})

test('roster exit, pending invites and actual presence cancel proposals; stale session identity cannot authorize a vote', () => {
    const f = targetFixture()
    try {
        f.create(2)
        f.call(0, 'TeamV2InviteJoinTeam', { team_id: f.room().id, player_id: f.id(2) })
        f.propose()
        assert.throws(
            () => f.call(2, 'TeamV2ReplyInviteJoin', { team_id: f.room().id, player_id: f.id(2), is_accept: true }),
            code(ErrorCode.TeamWaitStateSync),
        )
        const team = f.room().id
        f.call(1, 'TeamV2LeaveTeam', { team_id: team })
        assert.equal(f.game.teamV2.changes.get(team).status, 'cancelled')
        assert.equal(f.room().change_target, undefined)
        f.call(2, 'TeamV2ReplyInviteJoin', { team_id: team, player_id: f.id(2), is_accept: true })
        f.propose()
        f.sessions[2].entered = false
        f.consume(0, f.game.teamV2.presence(f.id(2), false, f.now()))
        assert.equal(f.game.teamV2.changes.get(team).status, 'cancelled')
        assert(f.models.get(f.id(0)).team.member_list.every((m) => m.player_id !== f.id(2) || !m.online))
        f.sessions[2].entered = true
        f.propose()
        f.sessions[2].token += '-replaced'
        f.vote(2)
        assert.equal(f.game.teamV2.changes.get(team).status, 'cancelled')
        assert.equal(f.room().target.dungeon_system_id, 10101)
    } finally {
        f.close()
    }
})

test('actual update encoding and late SQL failures roll back proposal/votes/room/sequence and player drafts', () => {
    const f = targetFixture({ count: 2 })
    try {
        f.create()
        const packet = f.game.packet,
            before = dump(f)
        try {
            f.game.packet = function (name, value, ...args) {
                if (name === 'CSProtoTeamV2TeamUpdateNotify' && value.reason === 11)
                    throw Error('proposal-notify-codec')
                return packet.call(this, name, value, ...args)
            }
            assert.throws(() => f.propose(), /proposal-notify-codec/)
            assert.deepEqual(dump(f), before)
        } finally {
            f.game.packet = packet
        }
        f.propose()
        const pending = dump(f)
        f.store.db.exec(
            "CREATE TRIGGER reject_team_target BEFORE UPDATE ON team_v2_rooms WHEN json_extract(NEW.payload,'$.target.dungeon_system_id')=10201 BEGIN SELECT RAISE(ABORT,'target-sql-failure'); END;",
        )
        assert.throws(() => f.vote(1), /target-sql-failure/)
        assert.deepEqual(dump(f), pending)
        f.store.db.exec('DROP TRIGGER reject_team_target')
        try {
            f.game.packet = function (name, value, ...args) {
                if (name === 'CSProtoTeamV2TeamUpdateNotify' && value.reason === 13) throw Error('commit-notify-codec')
                return packet.call(this, name, value, ...args)
            }
            assert.throws(() => f.vote(1), /commit-notify-codec/)
            assert.deepEqual(dump(f), pending)
        } finally {
            f.game.packet = packet
        }
        f.vote(1)
        assert.equal(f.room().target.dungeon_system_id, 10201)
    } finally {
        f.close()
    }
})

test('real SQLite reopen preserves committed targets and cancels old-connection pending votes on the next ordinary request', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-team-target-')),
        f = targetFixture({ count: 2, file: path.join(directory, 'private.sqlite') })
    try {
        f.create()
        f.propose()
        f.vote(1)
        const team = f.room().id
        f.reopen()
        assert.equal(f.room().id, team)
        assert.equal(f.room().target.dungeon_system_id, 10201)
        f.propose(10301)
        f.reopen()
        assert.equal(f.room().target.dungeon_system_id, 10201)
        assert.equal(f.game.teamV2.changes.get(team).status, 'cancelled')
        assert.equal(f.room().change_target, undefined)
        f.vote(1)
        assert.equal(f.room().target.dungeon_system_id, 10201)
    } finally {
        f.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
