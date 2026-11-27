import { createHash } from 'node:crypto'
import defaults from '../configs/team-v2-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { teamV2Target, requireTeamV2Target } from './team-v2-eligibility.js'
import { teamV2MemberData } from './team-v2-member.js'
import { legacyChatBans } from './chat-shields.js'
import { TeamV2TargetChanges } from './team-v2-target-change.js'
import { TeamV2RunLedger } from './team-v2-run-ledger.js'
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => structuredClone(v)
const signature = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const busy = (s) => !!(s.entrust?.run || s.multiCampaign || s.storyCampaign || s.cultTrial || s.abyssRun)
const sameTarget = (a, b) => a.typ === b.typ && a.target.dungeon_system_id === b.target.dungeon_system_id
export const TeamV2Reason = Object.freeze({ NONE: 0, CREATE: 1, LOGIN: 2, JOIN: 7, PLAY: 8 })
export const TeamV2LeaveReason = Object.freeze({ LEAVE: 1, KICK: 2, DISMISS: 3 })
export const TeamV2MemberReason = Object.freeze({ LOGIN: 1, OFFLINE: 2, JOIN: 3, DATA: 4 })
function teamId(value) {
    const s = String(value ?? '')
    ensure(/^[1-9]\d*$/.test(s) && BigInt(s) <= 0x7fffffffn, 'Invalid TeamV2 identity', ErrorCode.ReqParamsError)
    return Number(s)
}
export class TeamV2Service {
    constructor(store, tables, { policy = defaults, encodeNotice } = {}) {
        this.store = store
        this.db = store.db
        this.tables = tables
        this.policy = clone(policy)
        this.encodeNotice = encodeNotice
        ensure(
            policy.schema_version === 1 &&
                policy.origin === 'LOCAL' &&
                policy.target_version === '1.0.0' &&
                policy.package_version === '3217420' &&
                policy.member_limit === 3 &&
                policy.room_id_namespace === 'team_v2_room' &&
                policy.invitation_permission === 'normal_lobby_members' &&
                policy.captain_exit === 'dismiss_as_current_Exit_sender' &&
                positive(policy.invitation_ttl_seconds) &&
                policy.offline_members === 'retain_and_publish_observed_boolean',
            'TeamV2 local policy is malformed',
            ErrorCode.GameConfig,
        )
        this.isOnline = () => false
        this.connectionKey = () => null
        this.backend = null
        this.db
            .exec(`CREATE TABLE IF NOT EXISTS team_v2_rooms(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS team_v2_members(player_id INTEGER PRIMARY KEY,team_id INTEGER NOT NULL,site INTEGER NOT NULL,UNIQUE(team_id,site));
   CREATE TABLE IF NOT EXISTS team_v2_invites(recipient_id INTEGER PRIMARY KEY,team_id INTEGER NOT NULL,inviter_id INTEGER NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS team_v2_invite_history(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS team_v2_leave_receipts(team_id INTEGER NOT NULL,player_id INTEGER NOT NULL,reason INTEGER NOT NULL,PRIMARY KEY(team_id,player_id));
   CREATE TABLE IF NOT EXISTS team_v2_room_receipts(team_id INTEGER PRIMARY KEY,captain INTEGER NOT NULL,payload TEXT NOT NULL);`)
        this.changes = new TeamV2TargetChanges(this)
        this.runs = new TeamV2RunLedger(this)
    }
    requireTransaction() {
        ensure(this.db.inTransaction, 'TeamV2 mutation requires an atomic transaction', ErrorCode.GameConfig)
    }
    validateRoom(room, row) {
        ensure(
            object(room) &&
                room.schema_version === 1 &&
                String(row.id) === room.id &&
                positive(room.revision) &&
                room.revision === row.revision &&
                positive(room.captain) &&
                [101, 500, 1].includes(room.typ) &&
                positive(room.target?.dungeon_system_id) &&
                uint(room.limit?.level) &&
                [1, 2, 3, 4].includes(room.state) &&
                Array.isArray(room.members) &&
                room.members.length > 0 &&
                room.members.length <= 3 &&
                Array.isArray(room.ready) &&
                positive(room.next_member_lease),
            'Saved TeamV2 room is malformed',
            ErrorCode.GameConfig,
        )
        const ids = new Set(),
            sites = new Set(),
            leases = new Set()
        for (const m of room.members) {
            ensure(
                object(m) &&
                    positive(m.id) &&
                    Number.isInteger(m.site) &&
                    m.site >= 1 &&
                    m.site <= 3 &&
                    positive(m.lease) &&
                    m.lease < room.next_member_lease &&
                    uint(m.joined_at) &&
                    (m.play === undefined || typeof m.play === 'boolean') &&
                    !ids.has(m.id) &&
                    !sites.has(m.site) &&
                    !leases.has(m.lease),
                'Saved TeamV2 member is malformed',
                ErrorCode.GameConfig,
            )
            ids.add(m.id)
            sites.add(m.site)
            leases.add(m.lease)
        }
        ensure(
            ids.has(room.captain) &&
                room.ready.every((id) => ids.has(id)) &&
                new Set(room.ready).size === room.ready.length,
            'Saved TeamV2 authority is malformed',
            ErrorCode.GameConfig,
        )
        const changeFields = ['change_target', 'change_vote', 'change_vote_time']
        ensure(
            changeFields.every((key) => room[key] === undefined) ||
                (room.state === 1 &&
                    positive(room.change_target?.dungeon_system_id) &&
                    Number.isSafeInteger(room.change_vote_time) &&
                    room.change_vote_time >= 0 &&
                    Array.isArray(room.change_vote) &&
                    room.change_vote.every((id) => ids.has(id)) &&
                    new Set(room.change_vote).size === room.change_vote.length),
            'Saved TeamV2 target proposal projection is malformed',
            ErrorCode.GameConfig,
        )
        const index = this.db
            .prepare('SELECT player_id,site FROM team_v2_members WHERE team_id=? ORDER BY site')
            .all(row.id)
        ensure(
            JSON.stringify(index) ===
                JSON.stringify(
                    [...room.members].sort((a, b) => a.site - b.site).map((m) => ({ player_id: m.id, site: m.site })),
                ),
            'TeamV2 membership index differs from its room',
            ErrorCode.GameConfig,
        )
        return room
    }
    getRoom(id) {
        const row = this.db.prepare('SELECT * FROM team_v2_rooms WHERE id=?').get(teamId(id))
        if (!row) return null
        let room
        try {
            room = JSON.parse(row.payload)
        } catch {
            ensure(false, 'Saved TeamV2 JSON is malformed', ErrorCode.GameConfig)
        }
        return this.validateRoom(room, row)
    }
    roomFor(id) {
        ensure(positive(id), 'Invalid TeamV2 member identity', ErrorCode.ReqParamsError)
        const index = this.db.prepare('SELECT team_id FROM team_v2_members WHERE player_id=?').get(id)
        if (!index) return null
        const room = this.getRoom(index.team_id)
        ensure(room, 'Orphan TeamV2 member index', ErrorCode.GameConfig)
        return room
    }
    requireRoom(c, id, { captain = false } = {}) {
        const room = this.getRoom(id)
        ensure(room, 'TeamV2 room does not exist', ErrorCode.TeamNotExists)
        ensure(
            room.members.some((m) => m.id === c.id),
            'Not a TeamV2 member',
            ErrorCode.NotInMatchTeam,
        )
        ensure(!captain || room.captain === c.id, 'Only the TeamV2 captain may operate', ErrorCode.IsNotMatchTeamLeader)
        return room
    }
    requireTarget(c, room, id, state) {
        return requireTeamV2Target(c, room, id, state)
    }
    memberData(state, id) {
        return teamV2MemberData(state, id)
    }
    readState(c, id, states) {
        return states?.get(id) ?? (id === c.id ? c.state : this.store.read(id, (s) => s))
    }
    snapshot(c, room, { states, onlineOverride } = {}) {
        return {
            team_id: room.id,
            typ: room.typ,
            captain: room.captain,
            state: room.state,
            target: clone(room.target),
            limit: clone(room.limit),
            prepare: [...room.ready],
            change_vote: [...(room.change_vote ?? [])],
            ...(room.change_target
                ? { change_target: clone(room.change_target), change_vote_time: String(room.change_vote_time) }
                : {}),
            ...(room.play ? { play: clone(room.play) } : {}),
            ...(room.pre_start_time ? { pre_start_time: String(room.pre_start_time) } : {}),
            ...(room.start_time ? { start_time: String(room.start_time) } : {}),
            member_list: [...room.members]
                .sort((a, b) => a.site - b.site)
                .map((m) => ({
                    player_id: m.id,
                    site: m.site,
                    online: onlineOverride?.has(m.id) ? onlineOverride.get(m.id) : m.id === c.id || this.isOnline(m.id),
                    play: m.play === true,
                    data: this.memberData(this.readState(c, m.id, states), m.id),
                })),
            invite_list: (room.invite_history ?? []).map((x) => ({
                player_id: x.player_id,
                invite_time: String(x.invite_time),
            })),
        }
    }
    notify(c, recipient, name, value) {
        if (recipient === c.id) c.pushBefore(name, value)
        else c.pushTo(recipient, name, value)
    }
    publish(c, room, reason, { states, recipientReasons, playerId = 0, checkList = [], onlineOverride } = {}) {
        const team = this.snapshot(c, room, { states, onlineOverride })
        for (const m of room.members)
            this.notify(c, m.id, 'CSProtoTeamV2TeamUpdateNotify', {
                reason: recipientReasons?.get(m.id) ?? reason,
                team,
                player_id: playerId,
                ...(checkList.length ? { check_list: checkList } : {}),
            })
    }
    publishMember(c, room, id, reason, options = {}) {
        const member = this.snapshot(c, room, options).member_list.find((m) => m.player_id === id)
        ensure(member, 'TeamV2 member update target is unavailable', ErrorCode.GameConfig)
        for (const target of room.members)
            this.notify(c, target.id, 'CSProtoTeamV2MemberUpdateNotify', { team_id: room.id, reason, member })
    }
    commitRoom(c, room, reason, options = {}) {
        this.requireTransaction()
        const previous = this.getRoom(room.id)
        ensure(previous && previous.revision === room.revision, 'TeamV2 revision changed', ErrorCode.TeamWaitStateSync)
        ensure(room.revision < 0xffffffff, 'TeamV2 revision exhausted', ErrorCode.GameConfig)
        const saved = { ...clone(room), revision: room.revision + 1 }
        const result = this.db
            .prepare('UPDATE team_v2_rooms SET revision=?,payload=? WHERE id=? AND revision=?')
            .run(saved.revision, JSON.stringify(saved), teamId(saved.id), room.revision)
        ensure(result.changes === 1, 'TeamV2 revision changed', ErrorCode.TeamWaitStateSync)
        this.validateRoom(saved, { id: teamId(saved.id), revision: saved.revision })
        this.publish(c, saved, reason, options)
        return saved
    }
    requireLobby(c, state = c.state) {
        ensure(!busy(state), 'Cannot operate a TeamV2 lobby during a dungeon', ErrorCode.TeamInBattle)
        ensure(
            [1, 3, 4].includes(this.tables.find('world_city', state.world.map_id)?.type),
            'TeamV2 lobby scene is unavailable',
            ErrorCode.CannotMatch,
        )
    }
    legacyMember(id) {
        return !!this.db.prepare('SELECT room_id FROM legacy_match_members WHERE player_id=?').get(id)
    }
    requireNormal(room, { allowTargetChange = false } = {}) {
        ensure(room.state === 1, 'TeamV2 is not in its normal lobby state', ErrorCode.TeamWaitStateSync)
        ensure(
            allowTargetChange || !room.change_target,
            'A TeamV2 target proposal is pending',
            ErrorCode.TeamWaitStateSync,
        )
    }
    updateLimit(c, r) {
        this.requireTransaction()
        const room = this.requireRoom(c, r.team_id, { captain: true })
        this.requireLobby(c)
        this.requireNormal(room)
        const limit = r.team_limit
        ensure(
            object(limit) && Object.keys(limit).every((key) => key === 'level') && uint(limit.level),
            'Malformed TeamV2 level setting',
            ErrorCode.ReqParamsError,
        )
        // Current PageMultipleTeamSetting06018cc1 builds its choices from
        // this table;it does not clamp them to the captain's own level.
        const rows = this.tables.get('game').filter((row) => row.title === 'MULTI_TEAM_SET_LEVEL')
        ensure(
            rows.length === 1 && rows[0].type === 'list<int>' && /^[1-9]\d*(\|[1-9]\d*)*$/.test(rows[0].value),
            'TeamV2 level choices are unavailable',
            ErrorCode.GameConfig,
        )
        const levels = rows[0].value.split('|').map(Number)
        ensure(
            levels.every(positive) && new Set(levels).size === levels.length,
            'Invalid TeamV2 level choices',
            ErrorCode.GameConfig,
        )
        ensure(levels.includes(limit.level), 'TeamV2 level is not a current setting choice', ErrorCode.ReqParamsError)
        if (room.limit.level === limit.level) {
            this.notify(c, c.id, 'CSProtoTeamV2TeamUpdateNotify', {
                reason: 10,
                team: this.snapshot(c, room),
                player_id: c.id,
            })
            return room
        }
        room.limit = { level: limit.level }
        // This changes later admission,not the current roster or target.
        // Existing invite acceptance already rechecks room.limit.level.
        return this.commitRoom(c, room, 10, { playerId: c.id })
    }
    create(c, r) {
        this.requireTransaction()
        ensure(r.player_id === c.id, 'TeamV2 creator identity differs from the request actor', ErrorCode.ReqParamsError)
        this.requireLobby(c)
        const target = teamV2Target(this.tables, r.typ, r.target),
            limit = { level: r.limit?.level ?? 0 }
        ensure(uint(limit.level), 'TeamV2 level limit is malformed', ErrorCode.ReqParamsError)
        this.requireTarget(c, target, c.id, c.state)
        const existing = this.roomFor(c.id)
        if (existing) {
            ensure(
                sameTarget(existing, target) && existing.limit.level === limit.level,
                'Already in a different TeamV2 lobby',
                ErrorCode.IsInMatchTeam,
            )
            this.notify(c, c.id, 'CSProtoTeamV2TeamUpdateNotify', {
                reason: TeamV2Reason.CREATE,
                team: this.snapshot(c, existing),
            })
            return existing
        }
        ensure(!this.legacyMember(c.id), 'An existing legacy team must be left explicitly', ErrorCode.IsInMatchTeam)
        ensure(uint(c.now), 'Invalid TeamV2 clock', ErrorCode.GameConfig)
        const id = this.store.nextSequence('team_v2_room', 0x7fffffff)
        const room = {
            schema_version: 1,
            id: String(id),
            revision: 1,
            captain: c.id,
            ...target,
            limit,
            state: 1,
            members: [{ id: c.id, site: 1, joined_at: c.now, lease: 1 }],
            next_member_lease: 2,
            ready: [],
            created_at: c.now,
            invite_history: [],
            member_signatures: { [c.id]: signature(this.memberData(c.state, c.id)) },
        }
        this.db.prepare('INSERT INTO team_v2_rooms(id,revision,payload)VALUES(?,?,?)').run(id, 1, JSON.stringify(room))
        this.db.prepare('INSERT INTO team_v2_members(player_id,team_id,site)VALUES(?,?,?)').run(c.id, id, 1)
        this.publish(c, room, TeamV2Reason.CREATE)
        return room
    }
    parseInvite(row) {
        let value
        try {
            value = JSON.parse(row.payload)
        } catch {
            ensure(false, 'Saved TeamV2 invitation JSON is malformed', ErrorCode.GameConfig)
        }
        ensure(
            object(value) &&
                value.schema_version === 1 &&
                value.team_id === String(row.team_id) &&
                value.inviter === row.inviter_id &&
                value.recipient === row.recipient_id &&
                positive(value.inviter) &&
                positive(value.recipient) &&
                positive(value.inviter_lease) &&
                [101, 500, 1].includes(value.typ) &&
                positive(value.target?.dungeon_system_id) &&
                uint(value.expires_at) &&
                value.expires_at === row.expires_at &&
                Number.isInteger(value.site) &&
                value.site >= 0 &&
                value.site <= 3 &&
                ['pending', 'accepted', 'rejected', 'cancelled', 'expired'].includes(row.status),
            'Saved TeamV2 invitation authority is malformed',
            ErrorCode.GameConfig,
        )
        const wire = value.wire
        ensure(
            object(wire) &&
                wire.player_id === value.inviter &&
                wire.target_player === value.recipient &&
                wire.team_id === value.team_id &&
                wire.team_typ === value.typ &&
                wire.target?.dungeon_system_id === value.target.dungeon_system_id &&
                wire.site === value.site &&
                typeof wire.player_name === 'string' &&
                typeof wire.target_player_name === 'string',
            'Saved TeamV2 invitation wire metadata is malformed',
            ErrorCode.GameConfig,
        )
        return value
    }
    invite(c, r) {
        this.requireTransaction()
        const room = this.requireRoom(c, r.team_id)
        this.requireNormal(room)
        this.requireLobby(c)
        this.requireTarget(c, room, c.id, c.state)
        const id = r.player_id
        ensure(positive(id) && id !== c.id, 'Invalid TeamV2 invitee', ErrorCode.InvalidTarget)
        ensure(this.store.hasPlayer(id), 'TeamV2 invitee does not exist', ErrorCode.InvalidTarget)
        ensure(
            !this.roomFor(id) && !this.legacyMember(id),
            'Invited player is already in a team',
            ErrorCode.TargetAlreadyInTeam,
        )
        ensure(this.isOnline(id), 'Invited player is offline', ErrorCode.PlayerNotOnline)
        const peer = this.store.read(id, (s) => s)
        this.requireLobby(c, peer)
        this.requireTarget(c, room, id, peer)
        ensure(
            peer.player.basic_info.lv >= room.limit.level,
            'Invitee does not meet the room level limit',
            ErrorCode.TeamMemberLevelNotMet,
        )
        ensure(!legacyChatBans(c.state).has(id), 'Inviter has blocked the target', ErrorCode.YouBanTarget)
        ensure(!legacyChatBans(peer).has(c.id), 'Target has blocked the inviter', ErrorCode.TargetBanYou)
        ensure(room.members.length < 3, 'TeamV2 is full', ErrorCode.TeamFull)
        const site = r.site ?? 0
        ensure(
            Number.isInteger(site) && site >= 0 && site <= 3,
            'Invalid TeamV2 invitation site',
            ErrorCode.ReqParamsError,
        )
        ensure(
            !site || !room.members.some((m) => m.site === site),
            'Requested TeamV2 site is occupied',
            ErrorCode.TeamFull,
        )
        const old = this.db.prepare('SELECT * FROM team_v2_invites WHERE recipient_id=?').get(id)
        if (old && old.status === 'pending' && old.expires_at > c.now) {
            const offer = this.parseInvite(old)
            ensure(
                old.team_id === teamId(room.id) && old.inviter_id === c.id,
                'Another TeamV2 invitation is pending',
                ErrorCode.TargetBeingInvited,
            )
            this.notify(c, id, 'CSProtoTeamV2InviteSync', { reason: 10, invite_join_team: offer.wire })
            return offer
        }
        if (old) this.parseInvite(old)
        if (old) this.db.prepare('INSERT INTO team_v2_invite_history(payload)VALUES(?)').run(JSON.stringify(old))
        const expires = c.now + this.policy.invitation_ttl_seconds
        ensure(uint(expires), 'TeamV2 invitation deadline is invalid', ErrorCode.GameConfig)
        const wire = {
            player_id: c.id,
            player_name: Buffer.from(c.state.player.basic_info.name, 'base64').toString('utf8'),
            target_player: id,
            target_player_name: Buffer.from(peer.player.basic_info.name, 'base64').toString('utf8'),
            team_id: room.id,
            team_typ: room.typ,
            target: clone(room.target),
            site,
        }
        const offer = {
            schema_version: 1,
            team_id: room.id,
            inviter: c.id,
            inviter_lease: room.members.find((m) => m.id === c.id).lease,
            recipient: id,
            site,
            target: clone(room.target),
            typ: room.typ,
            expires_at: expires,
            wire,
        }
        this.db
            .prepare(
                'INSERT INTO team_v2_invites(recipient_id,team_id,inviter_id,status,expires_at,payload)VALUES(?,?,?,?,?,?)ON CONFLICT(recipient_id)DO UPDATE SET team_id=excluded.team_id,inviter_id=excluded.inviter_id,status=excluded.status,expires_at=excluded.expires_at,payload=excluded.payload',
            )
            .run(id, teamId(room.id), c.id, 'pending', expires, JSON.stringify(offer))
        room.invite_history = room.invite_history.filter((x) => x.player_id !== id)
        room.invite_history.push({ player_id: id, invite_time: c.now })
        this.commitRoom(c, room, 0)
        this.notify(c, id, 'CSProtoTeamV2InviteSync', { reason: 10, invite_join_team: wire })
        return offer
    }
    reply(c, r) {
        this.requireTransaction()
        ensure(r.player_id === c.id, 'TeamV2 reply identity differs from actor', ErrorCode.ReqParamsError)
        const id = teamId(r.team_id),
            row = this.db.prepare('SELECT * FROM team_v2_invites WHERE recipient_id=?').get(c.id)
        ensure(row && row.team_id === id, 'No matching TeamV2 invitation', ErrorCode.NotInviteMatchTeam)
        const offer = this.parseInvite(row)
        const room = this.getRoom(id)
        ensure(room, 'Invited TeamV2 no longer exists', ErrorCode.TeamNotExists)
        if (row.status === 'accepted' && room.members.some((m) => m.id === c.id)) {
            this.notify(c, c.id, 'CSProtoTeamV2TeamUpdateNotify', {
                reason: room.state === 1 ? TeamV2Reason.JOIN : TeamV2Reason.LOGIN,
                team: this.snapshot(c, room),
            })
            return room
        }
        if (row.status === 'rejected' && !r.is_accept) return room
        ensure(row.status === 'pending', 'TeamV2 invitation is no longer pending', ErrorCode.NotInviteMatchTeam)
        ensure(c.now < row.expires_at, 'TeamV2 invitation has expired', ErrorCode.InviteMatchTeamExpired)
        ensure(
            offer.recipient === c.id &&
                offer.team_id === room.id &&
                offer.typ === room.typ &&
                offer.target.dungeon_system_id === room.target.dungeon_system_id &&
                room.members.some((m) => m.id === offer.inviter && m.lease === offer.inviter_lease),
            'TeamV2 invitation authority changed',
            ErrorCode.TeamTargetChanged,
        )
        if (!r.is_accept) {
            this.db.prepare("UPDATE team_v2_invites SET status='rejected' WHERE recipient_id=?").run(c.id)
            this.notify(c, offer.inviter, 'CSProtoTeamV2InviteSync', { reason: 11, invite_join_team: offer.wire })
            return room
        }
        this.requireNormal(room)
        this.requireLobby(c)
        ensure(
            !this.roomFor(c.id) && !this.legacyMember(c.id),
            'Invitee already joined another team',
            ErrorCode.HaveInvitedAccepted,
        )
        ensure(this.isOnline(offer.inviter), 'Inviter is offline', ErrorCode.PlayerNotOnline)
        const inviter = this.store.read(offer.inviter, (s) => s)
        this.requireLobby(c, inviter)
        this.requireTarget(c, room, c.id, c.state)
        this.requireTarget(c, room, offer.inviter, inviter)
        ensure(
            c.state.player.basic_info.lv >= room.limit.level,
            'Invitee does not meet the room level limit',
            ErrorCode.TeamMemberLevelNotMet,
        )
        ensure(!legacyChatBans(c.state).has(offer.inviter), 'Invitee has blocked inviter', ErrorCode.YouBanTarget)
        ensure(!legacyChatBans(inviter).has(c.id), 'Inviter has blocked invitee', ErrorCode.TargetBanYou)
        ensure(room.members.length < 3, 'TeamV2 became full', ErrorCode.TeamFull)
        const site = offer.site || [1, 2, 3].find((site) => !room.members.some((m) => m.site === site))
        ensure(
            site && !room.members.some((m) => m.site === site),
            'TeamV2 invitation site became occupied',
            ErrorCode.TeamFull,
        )
        room.members.push({ id: c.id, site, joined_at: c.now, lease: room.next_member_lease++ })
        ;(room.member_signatures ??= {})[c.id] = signature(this.memberData(c.state, c.id))
        const saved = this.commitMembership(c, room, TeamV2Reason.JOIN, new Map([[c.id, TeamV2Reason.JOIN]]))
        this.db.prepare("UPDATE team_v2_invites SET status='accepted' WHERE recipient_id=?").run(c.id)
        return saved
    }
    commitMembership(c, room, reason, recipientReasons) {
        this.requireTransaction()
        const previous = this.getRoom(room.id)
        ensure(
            previous && previous.revision === room.revision,
            'TeamV2 roster revision changed',
            ErrorCode.TeamWaitStateSync,
        )
        this.db.prepare('DELETE FROM team_v2_members WHERE team_id=?').run(teamId(room.id))
        for (const m of room.members)
            this.db
                .prepare('INSERT INTO team_v2_members(player_id,team_id,site)VALUES(?,?,?)')
                .run(m.id, teamId(room.id), m.site)
        const saved = { ...clone(room), revision: room.revision + 1 }
        this.db
            .prepare('UPDATE team_v2_rooms SET revision=?,payload=? WHERE id=? AND revision=?')
            .run(saved.revision, JSON.stringify(saved), teamId(room.id), room.revision)
        this.validateRoom(saved, { id: teamId(saved.id), revision: saved.revision })
        const team = this.snapshot(c, saved)
        for (const m of saved.members)
            this.notify(c, m.id, 'CSProtoTeamV2TeamUpdateNotify', { reason: recipientReasons?.get(m.id) ?? 0, team })
        return saved
    }
    leave(c, r, kick = false) {
        this.requireTransaction()
        if (!kick) {
            const current = this.roomFor(c.id)
            if (!current || current.id !== String(teamId(r.team_id))) {
                const receipt = this.db
                    .prepare('SELECT reason FROM team_v2_leave_receipts WHERE team_id=? AND player_id=?')
                    .get(teamId(r.team_id), c.id)
                ensure(receipt, 'No matching TeamV2 leave authority', ErrorCode.NotInMatchTeam)
                this.notify(c, c.id, 'CSProtoTeamV2MemberLeaveNotify', {
                    team_id: String(teamId(r.team_id)),
                    player_id: c.id,
                    reason: receipt.reason,
                })
                return current
            }
        }
        let room = this.requireRoom(c, r.team_id, { captain: kick })
        this.requireNormal(room, { allowTargetChange: true })
        const id = kick ? r.target_player : c.id
        if (kick)
            ensure(
                r.player_id === c.id && positive(id) && id !== c.id,
                'Invalid TeamV2 kick actor/target',
                ErrorCode.ReqParamsError,
            )
        ensure(
            room.members.some((m) => m.id === id),
            'Target is not a TeamV2 member',
            ErrorCode.NotInMatchTeam,
        )
        ensure(id !== room.captain, 'Captain uses the current dismiss operation', ErrorCode.FunctionClosed)
        room = this.changes.cancel(c, room, id)
        const reason = kick ? TeamV2LeaveReason.KICK : TeamV2LeaveReason.LEAVE
        this.db
            .prepare('INSERT OR REPLACE INTO team_v2_leave_receipts(team_id,player_id,reason)VALUES(?,?,?)')
            .run(teamId(room.id), id, reason)
        const previous = room.members.map((m) => m.id)
        room.members = room.members.filter((m) => m.id !== id)
        room.ready = room.ready.filter((x) => x !== id)
        delete room.member_signatures?.[id]
        const saved = this.commitMembership(c, room, 0)
        for (const recipient of previous)
            this.notify(c, recipient, 'CSProtoTeamV2MemberLeaveNotify', { team_id: room.id, player_id: id, reason })
        return saved
    }
    dismiss(c, r) {
        this.requireTransaction()
        if (!this.getRoom(r.team_id)) {
            const receipt = this.db
                .prepare('SELECT * FROM team_v2_room_receipts WHERE team_id=?')
                .get(teamId(r.team_id))
            ensure(receipt, 'No matching TeamV2 dismiss authority', ErrorCode.TeamNotExists)
            ensure(
                receipt.captain === c.id,
                'Only the original captain may repeat dismissal',
                ErrorCode.IsNotMatchTeamLeader,
            )
            this.notify(c, c.id, 'CSProtoTeamV2MemberLeaveNotify', {
                team_id: String(teamId(r.team_id)),
                player_id: c.id,
                reason: TeamV2LeaveReason.DISMISS,
            })
            return
        }
        let room = this.requireRoom(c, r.team_id, { captain: true })
        this.requireNormal(room, { allowTargetChange: true })
        room = this.changes.cancel(c, room)
        this.db
            .prepare('INSERT INTO team_v2_room_receipts(team_id,captain,payload)VALUES(?,?,?)')
            .run(teamId(room.id), room.captain, JSON.stringify(room))
        for (const m of room.members) {
            this.db
                .prepare('INSERT OR REPLACE INTO team_v2_leave_receipts(team_id,player_id,reason)VALUES(?,?,?)')
                .run(teamId(room.id), m.id, TeamV2LeaveReason.DISMISS)
            this.notify(c, m.id, 'CSProtoTeamV2MemberLeaveNotify', {
                team_id: room.id,
                player_id: m.id,
                reason: TeamV2LeaveReason.DISMISS,
            })
        }
        this.db
            .prepare("UPDATE team_v2_invites SET status='cancelled' WHERE team_id=? AND status='pending'")
            .run(teamId(room.id))
        this.db.prepare('DELETE FROM team_v2_members WHERE team_id=?').run(teamId(room.id))
        this.db.prepare('DELETE FROM team_v2_rooms WHERE id=?').run(teamId(room.id))
    }
    loginSnapshots(c) {
        const packets = [],
            room = this.roomFor(c.id)
        if (room)
            packets.push({ name: 'CSProtoTeamV2TeamUpdateNotify', value: { reason: 2, team: this.snapshot(c, room) } })
        const offer = this.db
            .prepare("SELECT * FROM team_v2_invites WHERE recipient_id=? AND status='pending' AND expires_at>?")
            .get(c.id, c.now)
        if (offer) {
            const raw = this.parseInvite(offer)
            packets.push({ name: 'CSProtoTeamV2InviteSync', value: { reason: 10, invite_join_team: raw.wire } })
        }
        return packets
    }
    observe(c) {
        let room = this.roomFor(c.id)
        if (!room || room.state !== 1) return false
        room = this.changes.reconcile(c, room)
        const next = signature(this.memberData(c.state, c.id))
        if (room.member_signatures?.[c.id] === next) return false
        ;(room.member_signatures ??= {})[c.id] = next
        this.commitRoom(c, room, 0)
        return true
    }
    presence(id, online, now) {
        ensure(typeof online === 'boolean' && uint(now), 'TeamV2 presence is malformed', ErrorCode.GameConfig)
        if (!this.store.hasPlayer(id)) return []
        ensure(typeof this.encodeNotice === 'function', 'TeamV2 notice encoder is unavailable', ErrorCode.GameConfig)
        return this.store.transact(
            id,
            0,
            (state, transaction) => {
                let room = this.roomFor(id)
                const packets = []
                if (!room) return packets
                const c = {
                    id,
                    state,
                    editPlayer: transaction?.editPlayer,
                    tables: this.tables,
                    now,
                    pushBefore: (name, value) => packets.push(this.encodeNotice(name, value, id)),
                    pushTo: (recipient, name, value) => packets.push(this.encodeNotice(name, value, recipient)),
                }
                room = this.changes.reconcile(c, room)
                if (this.backend?.onPresence) this.backend.onPresence(c, room, online)
                const current = this.roomFor(id)
                if (!current) return packets
                const member = current.members.find((m) => m.id === id)
                const payload = {
                    team_id: current.id,
                    reason: online ? TeamV2MemberReason.LOGIN : TeamV2MemberReason.OFFLINE,
                    member: {
                        player_id: id,
                        site: member.site,
                        online,
                        play: member.play === true,
                        data: this.memberData(state, id),
                    },
                }
                for (const target of current.members)
                    packets.push(this.encodeNotice('CSProtoTeamV2MemberUpdateNotify', payload, target.id))
                return packets
            },
            { skipUnchanged: true },
        )
    }
    lifecycle(c, r, method) {
        const room = this.requireRoom(c, r.team_id, { captain: method === 'startPrepare' })
        ensure(
            this.backend && typeof this.backend[method] === 'function',
            'A real shared TeamV2 run is not connected',
            ErrorCode.FunctionClosed,
        )
        return this.backend[method](c, room, r)
    }
}
export function registerTeamV2(on, store, tables, options) {
    const teams = new TeamV2Service(store, tables, options)
    for (const [name, method] of [
        ['TeamV2CreateTeam', 'create'],
        ['TeamV2InviteJoinTeam', 'invite'],
        ['TeamV2ReplyInviteJoin', 'reply'],
        ['TeamV2DismissTeam', 'dismiss'],
    ])
        on(name, (c, r) => {
            teams[method](c, r)
        })
    on('TeamV2LeaveTeam', (c, r) => {
        teams.leave(c, r)
    })
    on('TeamV2KickoutMember', (c, r) => {
        teams.leave(c, r, true)
    })
    on('TeamV2StartPrepare', (c, r) => {
        teams.lifecycle(c, r, 'startPrepare')
    })
    on('TeamV2Prepare', (c, r) => {
        teams.lifecycle(c, r, 'prepare')
    })
    on('TeamV2UpdateLimit', (c, r) => {
        teams.updateLimit(c, r)
    })
    on('TeamV2StartChangeTarget', (c, r) => {
        teams.changes.propose(c, r)
    })
    on('TeamV2VoteChangeTarget', (c, r) => {
        teams.changes.vote(c, r)
    })
    // These current entry points need the matching/change-target/shared-run
    // authority that is deliberately not faked by this executable lobby block.
    for (const name of [
        'TeamV2StartMatch',
        'TeamV2CancelMatch',
        'TeamV2CancelChangeTarget',
        'TeamV2WorldInvite',
        'TeamV2CancelTeamMatch',
        'TeamV2StartTeamMatch',
        'TeamV2Invite',
        'TeamV2CancelInvite',
        'TeamV2ReplyInvite',
        'TeamV2ApplyEnterTeam',
    ])
        on(name, (c, r) => {
            ensure(
                false,
                'This TeamV2 matching/recruitment/target-change capability is not implemented',
                ErrorCode.FunctionClosed,
            )
        })
    return teams
}
