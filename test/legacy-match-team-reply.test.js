import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ErrorCode } from '../src/error-codes.js'
import { teamFixture, teamMaterial, teamTables } from './legacy-match-team-fixture.js'
const code = (expected) => (error) => error.code === expected
const reply = (f, player, accepted = true, id = f.room().id) =>
    f.call(player, 'ReplyInviteJoin', { invite_id: String(id), is_accept: accepted })

test('real9522→9525→9527 creates two then three members, preserves another pending offer and sends recipient-correct9520 without ACK', () => {
    const f = teamFixture()
    try {
        f.create()
        f.invite(1, 2)
        f.invite(1, 3, 2)
        const own = f.state(1),
            peer = f.state(2),
            first = f.room()
        const joined = reply(f, 2)
        assert(!joined.some((packet) => packet.id === 9527))
        assert.deepEqual(
            joined
                .filter((packet) => packet.id === 9520)
                .map((packet) => packet.recipient ?? f.id(2))
                .sort(),
            [f.id(1), f.id(2)],
        )
        assert.equal(f.room().revision, first.revision + 1)
        assert.deepEqual(
            f.room().members.map((member) => member.id),
            [f.id(1), f.id(2)],
        )
        assert.equal(f.teams.invitationFor(f.id(2)).status, 'accepted')
        assert.equal(f.teams.invitationFor(f.id(3)).status, 'pending')
        assert.deepEqual(f.state(1), own)
        // The caller's ordinary progression observers may refresh their
        // derived caches on any request. Joining must preserve owned assets,
        // currency, active formation and world/run state.
        for (const key of ['heros_info', 'group_mgrs', 'basic_info', 'sbag_infos', 'soulessences_info'])
            assert.deepEqual(f.state(2).player[key], peer.player[key])
        for (const key of ['pets', 'world', 'entrust', 'inventory']) assert.deepEqual(f.state(2)[key], peer[key])
        const third = reply(f, 3)
        assert.deepEqual(
            f.room().members.map((member) => member.id),
            [f.id(1), f.id(2), f.id(3)],
        )
        for (const packet of third.filter((packet) => packet.id === 9520)) {
            const data = f.decode(packet)
            assert.deepEqual(
                data.team.members.map((member) => member.pid),
                [f.id(1), f.id(2), f.id(3)],
            )
            assert.deepEqual(data.team.online_players, [f.id(1), f.id(2), f.id(3)])
        }
        const saved = f.room()
        f.advance(60)
        const duplicate = reply(f, 2)
        assert.equal(duplicate.filter((packet) => packet.id === 9520).length, 1)
        assert.deepEqual(f.room(), saved)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_members').get().n, 3)
        assert.throws(() => f.invite(1, 4), code(ErrorCode.ExceedMatchTeamPlayerNum))
    } finally {
        f.store.close()
    }
})

test('acceptance rechecks real table level and previous-clear conditions even when a legitimate offer was already issued', () => {
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
        f.edit(2, unlock)
        f.create(1, locked.dungeonId)
        f.invite(1, 2)
        f.edit(2, (state) => {
            state.player.basic_info.lv = 1
        })
        assert.throws(() => reply(f, 2), code(ErrorCode.TeamTargetLevelNotMet))
        f.edit(2, (state) => {
            state.player.basic_info.lv = 15
            state.materialDungeonRecords = {}
        })
        assert.throws(() => reply(f, 2), code(ErrorCode.TargetUnlockSystem))
        assert.equal(f.room(2), null)
        assert.equal(f.teams.invitationFor(f.id(2)).status, 'pending')
        f.edit(2, unlock)
        reply(f, 2)
        assert.equal(f.room(2).id, f.room().id)
    } finally {
        f.store.close()
    }
})

test('proto-default false declines the actual offer, notifies the inviter via9532 and releases its reserved place exactly once', () => {
    const f = teamFixture()
    try {
        f.create()
        f.invite(1, 2)
        f.invite(1, 3, 2)
        const packets = f.call(2, 'ReplyInviteJoin', { invite_id: String(f.room().id) })
        const rejected = packets.find((packet) => packet.id === 9532)
        assert.equal(rejected.recipient, f.id(1))
        assert.deepEqual(f.decode(rejected), {
            pid: f.id(2),
            name: Buffer.from(f.state(2).player.basic_info.name, 'base64').toString('utf8'),
        })
        assert.equal(f.room(2), null)
        assert.equal(f.teams.invitationFor(f.id(2)).status, 'declined')
        assert(!reply(f, 2, false).some((packet) => packet.id === 9532))
        assert.throws(() => reply(f, 2, true), code(ErrorCode.NotInviteMatchTeam))
        f.invite(1, 4)
        assert.equal(f.teams.invitationFor(f.id(4)).status, 'pending')
    } finally {
        f.store.close()
    }
})

test('foreign users, mismatched optional targets and full uint64 identities cannot authorize joining', () => {
    const f = teamFixture()
    try {
        f.create()
        f.invite(1, 2)
        assert.throws(() => reply(f, 3), code(ErrorCode.NotInviteMatchTeam))
        for (const id of ['0', '2147483648', '9007199254740993', '18446744073709551615'])
            assert.throws(
                () => f.call(2, 'ReplyInviteJoin', { invite_id: id, is_accept: true }),
                code(ErrorCode.ReqParamsError),
            )
        assert.throws(
            () =>
                f.call(2, 'ReplyInviteJoin', {
                    invite_id: String(f.room().id),
                    dungeon_id: 0xffffffff,
                    is_accept: true,
                }),
            code(ErrorCode.TeamTargetChanged),
        )
        assert.equal(f.room(2), null)
        assert.equal(f.teams.invitationFor(f.id(2)).status, 'pending')
        assert(reply(f, 2).some((packet) => packet.id === 9520))
    } finally {
        f.store.close()
    }
})

test('expiry uses an exclusive30s boundary, and room destruction cannot leave an offer that joins a replacement room', () => {
    for (const seconds of [29, 30]) {
        const f = teamFixture()
        try {
            f.create()
            f.invite(1, 2)
            f.advance(seconds)
            if (seconds === 29) reply(f, 2)
            else {
                assert.throws(() => reply(f, 2), code(ErrorCode.InviteMatchTeamExpired))
                assert.equal(f.room(2), null)
                assert.equal(f.teams.invitationFor(f.id(2)).status, 'pending')
            }
        } finally {
            f.store.close()
        }
    }
    const f = teamFixture()
    try {
        f.create()
        f.invite(1, 2)
        const old = f.room().id
        f.call(1, 'LeaveMatchTeam')
        f.create()
        assert.notEqual(f.room().id, old)
        assert.throws(() => reply(f, 2, true, old), code(ErrorCode.NotInviteMatchTeam))
        assert.equal(f.room(2), null)
    } finally {
        f.store.close()
    }
})

test('acceptance rechecks current connection, both blacklists and active team state before adding any member', () => {
    const f = teamFixture()
    try {
        f.create()
        f.invite(1, 2)
        f.online.delete(f.id(1))
        assert.throws(() => reply(f, 2), code(ErrorCode.PlayerNotOnline))
        f.online.add(f.id(1))
        f.edit(1, (state) => {
            state.blockedPlayers = [f.id(2)]
        })
        assert.throws(() => reply(f, 2), code(ErrorCode.TargetBanYou))
        f.edit(1, (state) => {
            state.blockedPlayers = []
        })
        f.edit(2, (state) => {
            state.blockedPlayers = [f.id(1)]
        })
        assert.throws(() => reply(f, 2), code(ErrorCode.YouBanTarget))
        f.edit(2, (state) => {
            state.blockedPlayers = []
        })
        f.edit(1, (state) => {
            state.multiCampaign = { isolated_fixture: true }
        })
        assert.throws(() => reply(f, 2), code(ErrorCode.TeamInBattle))
        f.edit(1, (state) => {
            delete state.multiCampaign
        })
        assert.equal(f.room(2), null)
        assert.equal(f.teams.invitationFor(f.id(2)).status, 'pending')
        reply(f, 2)
        assert.equal(f.room(2).id, f.room().id)
    } finally {
        f.store.close()
    }
})

test('either acceptance peer-notification or decline encoding failure rolls back the receipt and unique membership index', () => {
    for (const accepted of [true, false]) {
        const f = teamFixture(),
            original = f.protocol.encode.bind(f.protocol)
        try {
            f.create()
            f.invite(1, 2)
            const room = f.room(),
                offer = f.teams.invitationFor(f.id(2)),
                state = f.state(2)
            let notifications = 0
            f.protocol.encode = (type, value) => {
                if (
                    (accepted && type === f.protocol.byId.get(9520).rsp && ++notifications === 2) ||
                    (!accepted && type === f.protocol.byId.get(9532).rsp)
                )
                    throw Error('isolated reply notification failure')
                return original(type, value)
            }
            assert.throws(() => reply(f, 2, accepted), /isolated reply notification failure/)
            assert.deepEqual(f.room(), room)
            assert.equal(f.room(2), null)
            assert.deepEqual(f.teams.invitationFor(f.id(2)), offer)
            assert.deepEqual(f.state(2), state)
            f.protocol.encode = original
            reply(f, 2, accepted)
            assert.equal(f.teams.invitationFor(f.id(2)).status, accepted ? 'accepted' : 'declined')
        } finally {
            f.protocol.encode = original
            f.store.close()
        }
    }
})

test('configured ordinary-member invitations use the actual inviter receipt while captain remains unchanged', () => {
    const f = teamFixture()
    try {
        f.create()
        f.invite(1, 2)
        reply(f, 2)
        assert.throws(() => f.invite(2, 3), code(ErrorCode.IsNotMatchTeamLeader))
        f.teams.policy.invite_permission = 'members'
        const packets = f.invite(2, 3)
        assert.equal(f.decode(packets.find((packet) => packet.id === 9521)).invite.pid, f.id(2))
        reply(f, 3)
        assert.equal(f.room().captain, f.id(1))
        assert.deepEqual(
            f.room().members.map((member) => member.id),
            [f.id(1), f.id(2), f.id(3)],
        )
    } finally {
        f.store.close()
    }
})

test('accepted membership and receipt survive real SQLite reopen and duplicate reply does not add another participant', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-team-reply-')),
        database = path.join(directory, 'state.db'),
        stores = []
    try {
        const first = teamFixture({ database, count: 3, account: 'durable-reply' })
        stores.push(first.store)
        first.create()
        first.invite(1, 2)
        reply(first, 2)
        const room = first.room()
        first.store.close()
        const next = teamFixture({ database, count: 3, account: 'durable-reply' })
        stores.push(next.store)
        assert.deepEqual(next.room(), room)
        assert.equal(next.teams.invitationFor(next.id(2)).status, 'accepted')
        reply(next, 2)
        assert.deepEqual(next.room(), room)
        assert.equal(next.store.db.prepare('SELECT count(*) AS n FROM legacy_match_members').get().n, 2)
    } finally {
        for (const store of stores) store.close()
        const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory))
        assert(
            relative &&
                !relative.startsWith('..') &&
                !path.isAbsolute(relative) &&
                path.basename(directory).startsWith('luruka-team-reply-'),
        )
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
