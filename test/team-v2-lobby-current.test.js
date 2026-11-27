import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { teamV2MemberData } from '../src/team-v2-member.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const ids = {
    team: protocol.byName.get('CSProtoTeamV2TeamUpdateNotify').id,
    invite: protocol.byName.get('CSProtoTeamV2InviteSync').id,
    leave: protocol.byName.get('CSProtoTeamV2MemberLeaveNotify').id,
    member: protocol.byName.get('CSProtoTeamV2MemberUpdateNotify').id,
}
class Consumer {
    constructor(id) {
        this.id = id
        this.team = null
        this.invite = null
        this.loadingEnters = 0
    }
    consume(packet) {
        const e = protocol.byId.get(packet.id),
            r = protocol.decode(e.rsp, packet.payload)
        if (packet.id === ids.team) {
            assert(r.team.member_list.some((m) => m.player_id === r.team.captain))
            assert.equal(new Set(r.team.member_list.map((m) => m.site)).size, r.team.member_list.length)
            for (const m of r.team.member_list) {
                assert(m.site >= 1 && m.site <= 3)
                assert(m.data.group.hero_list.some((h) => h.hero_id === m.data.group.control_hero))
            }
            if ([0, 1, 2, 7].includes(r.reason)) this.team = structuredClone(r.team)
            else if (this.team) this.team.state = r.team.state
        }
        if (packet.id === ids.invite && r.reason === 10) {
            assert.equal(r.invite_join_team.target_player, this.id)
            this.invite = r.invite_join_team
        }
        if (packet.id === ids.leave && this.team?.team_id === r.team_id) {
            if (r.player_id === this.id) this.team = null
            else this.team.member_list = this.team.member_list.filter((m) => m.player_id !== r.player_id)
        }
        if (packet.id === ids.member && this.team?.team_id === r.team_id) {
            const i = this.team.member_list.findIndex((m) => m.player_id === r.member.player_id)
            assert(i >= 0)
            this.team.member_list[i] = r.member
        }
    }
}
function fixture({ count = 4, file = ':memory:', progress = true } = {}) {
    let now = 1800000000,
        store = new Store(file, { flushIntervalMs: 60000 }),
        game,
        sessions = Array.from({ length: count }, () => ({})),
        seq = 1
    const names = Array.from({ length: count }, (_, i) => `v2-lobby-${++fixture.counter}-${i}`),
        models = new Map()
    const make = () => {
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
        assert(game.handlers.has(protocol.byName.get('CSProtoTeamV2CreateTeam').id))
        game.teamV2.isOnline = (id) => sessions.some((s) => s.id === id && s.entered)
        game.teamV2.connectionKey = (id) => sessions.find((s) => s.id === id && s.entered)?.token ?? null
    }
    const state = (who) => store.load(sessions[who].id).state
    const route = (who, packets) => {
        for (const p of packets) {
            if (!Object.values(ids).includes(p.id)) continue
            const recipient = p.recipient ?? sessions[who].id
            if (!models.has(recipient)) models.set(recipient, new Consumer(recipient))
            models.get(recipient).consume(p)
        }
    }
    const call = (who, name, r = {}, consume = true) => {
        const e = protocol.byName.get('CSProto' + name)
        assert(e)
        const out = game.dispatch(sessions[who], {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
        if (consume) route(who, out)
        return out
    }
    make()
    for (let who = 0; who < count; who++) {
        call(who, 'EnterGame', { open_id: names[who] })
        models.set(sessions[who].id, new Consumer(sessions[who].id))
        if (progress) {
            call(who, 'PlayerCustomData', {
                name: Buffer.from('冒险者' + (who + 1)).toString('base64'),
                wardrobe_info: { ...state(who).player.basic_info.wardrobe, sex: 2 },
            })
            store.transact(sessions[who].id, 0, (s) => {
                s.tasks = []
                s.taskRecords = [106001, 106002, 106009, 106010, 106012, 106013].map((task_id) => ({
                    task_id,
                    count: 1,
                    time: now - 1,
                }))
                s.characterCustomized = true
                s.player.basic_info.lv = 40
                Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
                s.entrust ??= { records: {}, starRewards: [], nextInstanceId: 1 }
                s.entrust.records = {
                    ...s.entrust.records,
                    3: { entrust_star: 1 },
                    5: { entrust_star: 1 },
                    8: { entrust_star: 1 },
                }
            })
            call(who, 'WorldTimeSync', { world_time: 123 })
        }
    }
    const id = (who) => sessions[who].id,
        create = (who = 0) =>
            call(who, 'TeamV2CreateTeam', {
                player_id: id(who),
                typ: 101,
                target: { dungeon_system_id: 10101 },
                limit: { level: 0 },
            })
    const room = (who) => game.teamV2.roomFor(id(who)),
        offer = (from, to) => call(from, 'TeamV2InviteJoinTeam', { team_id: room(from).id, player_id: id(to) }),
        accept = (who, team) =>
            call(who, 'TeamV2ReplyInviteJoin', { team_id: team, player_id: id(who), is_accept: true })
    const dump = () => ({
        players: sessions.map((s) => store.load(s.id)),
        pending: [...store.pending.entries()],
        sql: [
            'players',
            'sequences',
            'team_v2_rooms',
            'team_v2_members',
            'team_v2_invites',
            'team_v2_invite_history',
            'team_v2_leave_receipts',
            'team_v2_room_receipts',
        ].map((t) => [t, store.db.prepare('SELECT * FROM ' + t + ' ORDER BY 1,2').all()]),
    })
    return {
        call,
        state,
        id,
        create,
        room,
        offer,
        accept,
        models,
        route,
        dump,
        get store() {
            return store
        },
        get game() {
            return game
        },
        get sessions() {
            return sessions
        },
        advance: (n) => {
            now += n
        },
        now: () => now,
        close() {
            store.close()
        },
        reopen() {
            store.close()
            store = new Store(file, { flushIntervalMs: 60000 })
            sessions = Array.from({ length: count }, () => ({}))
            models.clear()
            make()
            for (let who = 0; who < count; who++) {
                const packets = call(who, 'EnterGame', { open_id: names[who], reconnect: true })
                const team = packets.findIndex((p) => p.id === ids.team)
                if (team >= 0)
                    assert(packets.findIndex((p) => p.id === 5001) < team, 'own bootstrap must precede lobby team data')
            }
        },
    }
}
fixture.counter = 0
const same = (v) => JSON.stringify(v)

test('actual current5100 qualification→11820/create11823→queued11827→recipient11859→11829 joins and publishes valid current consumer roster', () => {
    const f = fixture({ count: 2 })
    try {
        const q = protocol.byName.get('CSProtoPlayerInfo'),
            out = f.call(0, 'PlayerInfo', {
                types: [0],
                player_ids: [f.id(1)],
                dungeon_query_list: [{ campaign_type: 101, dungeon_system_id: 10101 }],
            }),
            reply = protocol.decode(q.rsp, out.find((p) => p.id === q.id).payload)
        assert.deepEqual(reply.player_infos[0].dungeon_unlock_list, [
            { campaign_type: 101, dungeon_system_id: 10101, unlock: true },
        ])
        const created = f.create(),
            team = f.room(0).id
        assert(created.some((p) => p.id === ids.team))
        assert(!created.some((p) => p.id === 11820))
        assert.equal(f.models.get(f.id(0)).team.team_id, team)
        const offered = f.offer(0, 1)
        assert(offered.some((p) => p.id === ids.invite && p.recipient === f.id(1)))
        assert(!offered.some((p) => p.id === 11828))
        assert.equal(f.models.get(f.id(1)).invite.team_id, team)
        const accepted = f.accept(1, team)
        assert(!accepted.some((p) => p.id === 11829))
        for (const who of [0, 1])
            assert.deepEqual(
                f.models.get(f.id(who)).team.member_list.map((m) => m.player_id),
                [f.id(0), f.id(1)],
            )
        const seq = f.store.db.prepare("SELECT value FROM sequences WHERE name='team_v2_room'").get().value
        f.create()
        f.accept(1, team)
        assert.equal(f.room(0).members.length, 2)
        assert.equal(f.store.db.prepare("SELECT value FROM sequences WHERE name='team_v2_room'").get().value, seq)
        assert.equal(f.store.db.prepare('SELECT count(*) n FROM team_v2_rooms').get().n, 1)
    } finally {
        f.close()
    }
})

test('query is static current menu/row eligibility; online, existing team, busy, limits and caller/captain authority are checked by real operations', () => {
    const f = fixture()
    try {
        f.create()
        const team = f.room(0).id
        const q = protocol.byName.get('CSProtoPlayerInfo'),
            request = {
                types: [0],
                player_ids: [f.id(1)],
                dungeon_query_list: [{ campaign_type: 101, dungeon_system_id: 10101 }],
            }
        f.sessions[1].entered = false
        assert.equal(
            protocol.decode(q.rsp, f.call(0, 'PlayerInfo', request).find((p) => p.id === q.id).payload).player_infos[0]
                .dungeon_unlock_list[0].unlock,
            true,
            'offline is not silently recast as locked',
        )
        const before = same(f.dump())
        assert.throws(
            () => f.offer(0, 1),
            (e) => e.code === ErrorCode.PlayerNotOnline,
        )
        assert.equal(same(f.dump()), before)
        f.sessions[1].entered = true
        f.offer(0, 1)
        f.accept(1, team)
        assert.throws(
            () => f.call(1, 'TeamV2DismissTeam', { team_id: team }),
            (e) => e.code === ErrorCode.IsNotMatchTeamLeader,
        )
        assert.throws(
            () =>
                f.call(1, 'TeamV2CreateTeam', {
                    player_id: f.id(0),
                    typ: 101,
                    target: { dungeon_system_id: 10101 },
                    limit: { level: 0 },
                }),
            (e) => e.code === ErrorCode.ReqParamsError,
        )
        f.offer(1, 2)
        f.accept(2, team)
        assert.equal(f.room(0).members.length, 3)
        assert.throws(
            () => f.offer(0, 3),
            (e) => e.code === ErrorCode.TeamFull,
        )
        for (const [name, request, expected = ErrorCode.FunctionClosed] of [
            ['TeamV2StartMatch', { typ: 101, dungeon_system_id: 10101 }],
            // Now implemented: this particular current next-difficulty row
            // still requires its prior clear; it is not a closed capability.
            [
                'TeamV2StartChangeTarget',
                { team_id: team, target: { dungeon_system_id: 10102 } },
                ErrorCode.EntrustUnlock,
            ],
            ['TeamV2UpdateLimit', { team_id: team, team_limit: { level: 99 } }],
            ['TeamV2WorldInvite', { team_id: team }],
        ]) {
            const raw = same(f.dump())
            assert.throws(
                () => f.call(0, name, request),
                (e) => e.code === expected,
            )
            assert.equal(same(f.dump()), raw)
        }
        for (const name of ['TeamV2StartPrepare', 'TeamV2Prepare']) {
            const raw = same(f.dump())
            assert.throws(
                () =>
                    f.call(
                        0,
                        name,
                        name === 'TeamV2StartPrepare' ? { team_id: team } : { team_id: team, cancel: false },
                    ),
                (e) => e.code === ErrorCode.FunctionClosed,
            )
            assert.equal(same(f.dump()), raw)
        }
    } finally {
        f.close()
    }
})

test('all current typed material/weekly/crisis query targets use their real row and earned permanent menu; locked config is false and missing config is strict', () => {
    const f = fixture({ count: 2, progress: false })
    try {
        const e = protocol.byName.get('CSProtoPlayerInfo'),
            query = (camp, id) =>
                protocol.decode(
                    e.rsp,
                    f
                        .call(0, 'PlayerInfo', {
                            types: [0],
                            player_ids: [f.id(1)],
                            dungeon_query_list: [{ campaign_type: camp, dungeon_system_id: id }],
                        })
                        .find((p) => p.id === e.id).payload,
                ).player_infos[0].dungeon_unlock_list[0]
        for (const [camp, id] of [
            [101, 10101],
            [500, 101],
            [1, 10101],
        ])
            assert.equal(query(camp, id).unlock, false)
        const raw = same(f.dump())
        assert.throws(
            () => query(101, 0xffffffff),
            (e) => e.code === ErrorCode.DungeonConfNotExist,
        )
        assert.equal(same(f.dump()), raw)
        assert.throws(
            () => f.create(),
            (e) =>
                e.code === ErrorCode.TeamInBattle ||
                e.code === ErrorCode.CannotMatch ||
                e.code === ErrorCode.SystemLock,
        )
    } finally {
        f.close()
    }
    const earned = fixture({ count: 2 })
    try {
        const e = protocol.byName.get('CSProtoPlayerInfo')
        for (const [camp, id] of [
            [101, 10101],
            [500, 101],
            [1, 10101],
        ]) {
            const packets = earned.call(0, 'PlayerInfo', {
                types: [0],
                player_ids: [earned.id(1)],
                dungeon_query_list: [{ campaign_type: camp, dungeon_system_id: id }],
            })
            const value = protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload).player_infos[0]
                .dungeon_unlock_list[0]
            assert.deepEqual(value, { campaign_type: camp, dungeon_system_id: id, unlock: true })
        }
    } finally {
        earned.close()
    }
})

test('rejection/expiration do not join or reset assets; inviter membership lease cannot authorize an old offer after leaving and rejoining', () => {
    const f = fixture()
    try {
        f.create()
        const team = f.room(0).id
        f.offer(0, 1)
        f.call(1, 'TeamV2ReplyInviteJoin', { player_id: f.id(1), team_id: team, is_accept: false })
        assert.equal(f.room(1), null)
        f.call(1, 'TeamV2ReplyInviteJoin', { player_id: f.id(1), team_id: team, is_accept: false })
        assert.equal(f.room(1), null)
        f.offer(0, 1)
        f.advance(31)
        const expired = same(f.dump())
        assert.throws(
            () => f.accept(1, team),
            (e) => e.code === ErrorCode.InviteMatchTeamExpired,
        )
        assert.equal(same(f.dump()), expired)
        f.offer(0, 1)
        f.accept(1, team)
        const oldLease = f.room(1).members.find((m) => m.id === f.id(1)).lease
        f.offer(1, 2)
        f.call(1, 'TeamV2LeaveTeam', { team_id: team })
        f.offer(0, 1)
        f.accept(1, team)
        assert(f.room(1).members.find((m) => m.id === f.id(1)).lease > oldLease)
        const raw = same(f.dump())
        assert.throws(
            () => f.accept(2, team),
            (e) => e.code === ErrorCode.TeamTargetChanged,
        )
        assert.equal(same(f.dump()), raw)
    } finally {
        f.close()
    }
})

test('actual codec and SQLite failures roll back room/member/offer/history/receipt/sequence and both player drafts at every lifecycle boundary', () => {
    for (const phase of ['create', 'invite', 'accept', 'leave', 'dismiss'])
        for (const failure of ['codec', 'sql']) {
            const f = fixture({ count: 2 })
            try {
                if (phase !== 'create') f.create()
                let team = f.room(0)?.id
                if (['accept', 'leave', 'dismiss'].includes(phase)) f.offer(0, 1)
                if (['leave', 'dismiss'].includes(phase)) f.accept(1, team)
                const operation = () =>
                    phase === 'create'
                        ? f.create()
                        : phase === 'invite'
                          ? f.offer(0, 1)
                          : phase === 'accept'
                            ? f.accept(1, team)
                            : phase === 'leave'
                              ? f.call(1, 'TeamV2LeaveTeam', { team_id: team })
                              : f.call(0, 'TeamV2DismissTeam', { team_id: team })
                const before = same(f.dump()),
                    encode = protocol.encode
                if (failure === 'codec')
                    protocol.encode = function (type, value) {
                        const entry = protocol.byId.get(
                            phase === 'invite'
                                ? ids.invite
                                : ['leave', 'dismiss'].includes(phase)
                                  ? ids.leave
                                  : ids.team,
                        )
                        if (type === entry.rsp) throw new Error('TeamV2 codec boundary')
                        return encode.call(this, type, value)
                    }
                else {
                    const spec =
                        phase === 'create'
                            ? 'BEFORE INSERT ON team_v2_rooms'
                            : phase === 'dismiss'
                              ? 'BEFORE DELETE ON team_v2_rooms'
                              : 'BEFORE UPDATE ON team_v2_rooms'
                    f.store.db.exec(
                        `CREATE TRIGGER fail_team_v2 ${spec} BEGIN SELECT RAISE(ABORT,'TeamV2 SQL boundary'); END`,
                    )
                }
                try {
                    assert.throws(operation, /TeamV2 (codec|SQL) boundary/)
                } finally {
                    protocol.encode = encode
                    if (failure === 'sql') f.store.db.exec('DROP TRIGGER fail_team_v2')
                }
                assert.equal(same(f.dump()), before, `${phase}/${failure} changed rollback tuple`)
                operation()
                assert.equal(
                    f.store.db.prepare('SELECT count(*) n FROM team_v2_rooms').get().n,
                    phase === 'dismiss' ? 0 : 1,
                )
            } finally {
                f.close()
            }
        }
})

test('SQLite cold login, true member offline/online notifications, scoped leave/kick/dismiss and repeated old requests preserve assets and current teams', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-team-v2-')),
        f = fixture({ count: 3, file: path.join(dir, 'synthetic.sqlite') })
    try {
        f.create()
        const team = f.room(0).id
        f.offer(0, 1)
        f.accept(1, team)
        f.offer(0, 2)
        f.accept(2, team)
        const assets = f.sessions.map((_, i) =>
                same({
                    pets: f.state(i).pets,
                    bag: f.state(i).player.sbag_infos,
                    heroes: f.state(i).player.heros_info,
                }),
            ),
            roster = f.room(0).members.map((m) => [m.id, m.site, m.lease])
        f.reopen()
        assert.deepEqual(
            f.room(0).members.map((m) => [m.id, m.site, m.lease]),
            roster,
        )
        f.sessions[1].entered = false
        const offline = f.game.teamV2.presence(f.id(1), false, f.now())
        f.route(1, offline)
        assert.equal(f.models.get(f.id(0)).team.member_list.find((m) => m.player_id === f.id(1)).online, false)
        assert.equal(f.room(0).captain, f.id(0))
        f.sessions[1].entered = true
        f.route(1, f.game.teamV2.presence(f.id(1), true, f.now()))
        assert.equal(f.models.get(f.id(0)).team.member_list.find((m) => m.player_id === f.id(1)).online, true)
        f.call(1, 'TeamV2LeaveTeam', { team_id: team })
        assert.equal(f.models.get(f.id(1)).team, null)
        f.call(1, 'TeamV2LeaveTeam', { team_id: team })
        f.call(0, 'TeamV2KickoutMember', { team_id: team, player_id: f.id(0), target_player: f.id(2) })
        assert.equal(f.models.get(f.id(2)).team, null)
        f.call(0, 'TeamV2DismissTeam', { team_id: team })
        assert.equal(f.models.get(f.id(0)).team, null)
        f.call(0, 'TeamV2DismissTeam', { team_id: team })
        f.create(1)
        const newTeam = f.room(1).id
        f.call(1, 'TeamV2LeaveTeam', { team_id: team })
        assert.equal(f.room(1).id, newTeam, 'late old scoped receipt cannot remove new membership')
        for (let i = 0; i < 3; i++)
            assert.equal(
                same({
                    pets: f.state(i).pets,
                    bag: f.state(i).player.sbag_infos,
                    heroes: f.state(i).player.heros_info,
                }),
                assets[i],
            )
    } finally {
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('actual current pet grant and WearPet feed TeamV2 public member data without fabricating GUIDs or feature-to-special flags', () => {
    const f = fixture({ count: 2 })
    try {
        const b64 = (v) => Buffer.from(String(v)).toString('base64')
        f.call(0, 'GMCommand', { command: b64('give'), args: [5, 500001, 1].map(b64) })
        const pet = f.state(0).pets.find((p) => p.config_id === 500001),
            hero = f.state(0).player.heros_info.heros[0]
        assert(pet && hero)
        assert.equal(pet.feature, 1)
        f.call(0, 'WearPet', { hero_guid: hero.guid, pet_guid: pet.guid })
        f.create()
        const data = f.models
            .get(f.id(0))
            .team.member_list[0].data.group.hero_list.find((h) => h.hero_id === hero.conf_id).pet
        assert.deepEqual(data, { pet_id: pet.config_id, level: pet.lv, special: 0, color: pet.color ?? 0, colorful: 0 })
        assert.notEqual(String(data.pet_id), pet.guid)
        const damaged = structuredClone(f.state(0))
        damaged.pets.find((p) => p.guid === pet.guid).special = '1'
        assert.throws(
            () => teamV2MemberData(damaged, f.id(0)),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})
