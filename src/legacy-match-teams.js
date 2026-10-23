import { ErrorCode } from './error-codes.js'
import { ensure, group, GameError } from './handlers/common.js'
import { materialDungeonUnlocked } from './material-dungeons.js'
import { requireWeeklySystem, weeklyDungeonUnlocked } from './weekly-dungeons.js'
import { getEntrustCatalog } from './entrust.js'
import invitePolicy from '../configs/legacy-match-team-policy.json' with { type: 'json' }
import { legacyChatBans } from './chat-shields.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const playerId = (n) => uint(n) && n > 0
// MultiTeamStore::.ctor06018645 gives system types1/2 three positions.
// InviteData.team_id is cast to Int32 by SyncTeamInvite06025dcf.
const MAX_MEMBERS = 3
const MAX_ROOM_ID = 0x7fffffff
const busy = (state) =>
    !!(state.entrust?.run || state.multiCampaign || state.storyCampaign || state.cultTrial || state.abyssRun)
const sameTarget = (a, b) =>
    ['dungeon_id', 'scene_type', 'site_id', 'kind', 'config_id'].every((key) => a?.[key] === b?.[key])
const targetTables = Object.freeze({
    material: 'dungeon_material',
    weekly: 'dungeon_weekly',
    crisis: 'dungeon_crisiscrusade',
})

function targetDefinition(tables, target) {
    ensure(target && Object.hasOwn(targetTables, target.kind), 'Unknown saved team target family', ErrorCode.GameConfig)
    const row = tables.find(targetTables[target.kind], target.config_id)
    ensure(
        row?.dungeonId === target.dungeon_id,
        'Saved team target no longer matches its configuration',
        ErrorCode.GameConfig,
    )
    return row
}
function crisisUnlocked(condition, state) {
    ensure(typeof condition === 'string', 'Crisis unlock configuration unavailable', ErrorCode.GameConfig)
    ensure(playerId(state.player?.basic_info?.lv), 'Invalid saved crisis player level', ErrorCode.GameConfig)
    return condition
        .split('|')
        .filter(Boolean)
        .every((token) => {
            ensure(/^\d+#\d+$/.test(token), 'Invalid crisis unlock configuration', ErrorCode.GameConfig)
            const [kind, level] = token.split('#').map(Number)
            ensure(playerId(level), 'Invalid crisis level condition', ErrorCode.GameConfig)
            ensure(kind === 2004, 'Crisis unlock condition is not implemented', ErrorCode.FunctionClosed)
            return state.player.basic_info.lv >= level
        })
}

export function legacyMatchTarget(c, r) {
    ensure(playerId(r.dungeon_id), 'Invalid team dungeon identity', ErrorCode.ReqParamsError)
    ensure(uint(r.scene_type ?? 0) && uint(r.dungeon_site ?? 0), 'Invalid team scene', ErrorCode.ReqParamsError)
    ensure(
        r.scene_type === 12 && !r.dungeon_site && !r.random && !r.cancel,
        'This legacy team target family is not implemented',
        ErrorCode.FunctionClosed,
    )
    const candidates = Object.entries(targetTables).flatMap(([kind, table]) =>
        c.tables
            .get(table)
            .filter((row) => row.dungeonId === r.dungeon_id)
            .map((definition) => ({ kind, definition })),
    )
    ensure(candidates.length > 0, 'Team dungeon configuration unavailable', ErrorCode.DungeonConfNotExist)
    ensure(candidates.length === 1, 'Ambiguous team dungeon configuration', ErrorCode.GameConfig)
    const { kind, definition } = candidates[0]
    ensure(playerId(definition.id), 'Invalid team target configuration identity', ErrorCode.GameConfig)
    ensure(c.tables.find('dungeon', r.dungeon_id), 'Team dungeon definition unavailable', ErrorCode.DungeonConfNotExist)
    if (kind === 'crisis') {
        // Current legacy UI reads TDDungeonCrisiscrusade, not the similarly
        // numbered material table. Admit every configured row, not an ID list.
        ensure(crisisUnlocked(definition.taskUnlock, c.state), 'Crisis dungeon is locked', ErrorCode.EntrustUnlock)
        return { dungeon_id: r.dungeon_id, scene_type: 12, site_id: 0, kind, config_id: definition.id }
    }
    const entry = getEntrustCatalog(c.tables).get(definition.id, kind)
    if (kind === 'weekly') requireWeeklySystem(c)
    ensure(
        kind === 'weekly'
            ? weeklyDungeonUnlocked(entry.entrust.taskUnlock, c.state)
            : materialDungeonUnlocked(entry.entrust.taskUnlock, c.state),
        'Team dungeon is locked',
        ErrorCode.EntrustUnlock,
    )
    return { dungeon_id: r.dungeon_id, scene_type: 12, site_id: 0, kind, config_id: definition.id }
}

function memberSnapshot(state, id, joinedAt, tables) {
    const basic = state.player.basic_info,
        formation = group(state, 1)
    const heroes = formation.heros.map((slot) => {
        if (String(slot.hero_id) === '0') return { hero_id: 0, pet_id: 0 }
        const hero = state.player.heros_info.heros.find((row) => row.guid === String(slot.hero_id))
        ensure(hero, 'Team formation hero unavailable', ErrorCode.HeroNotExist)
        const pet =
            String(slot.pet_id ?? '0') === '0' ? null : state.pets.find((row) => row.guid === String(slot.pet_id))
        ensure(String(slot.pet_id ?? '0') === '0' || pet, 'Team formation pet unavailable', ErrorCode.PetNotExist)
        return {
            hero_id: hero.conf_id,
            pet_id: pet?.config_id ?? 0,
            hero_skin_id: hero.hero_skin ?? hero.conf_id,
        }
    })
    const control = state.player.heros_info.heros.find((row) => row.guid === String(formation.control))
    ensure(
        control && formation.heros.some((slot) => String(slot.hero_id) === control.guid),
        'Team formation control hero unavailable',
        ErrorCode.HeroNotExist,
    )
    return {
        pid: id,
        name: Buffer.from(basic.name, 'base64').toString('utf8'),
        lv: basic.lv,
        control_hero: control.conf_id,
        heros: heroes,
        ui_status: 0,
        ts: String(joinedAt),
        scene_type: tables.find('world_city', state.world.map_id)?.type ?? 0,
        wardrobe: basic.wardrobe,
        clothes: basic.clothes_info,
    }
}

// Room authority lives in SQLite, not a caller's cached player snapshot.
// Every mutation runs inside Store.transact; encoder failure rolls back the
// room, member index, sequence and all related player drafts together.
export class LegacyMatchTeams {
    constructor(store, tables) {
        this.store = store
        this.tables = tables
        this.db = store.db
        this.isOnline = () => false
        this.policy = structuredClone(invitePolicy)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS legacy_match_rooms (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS legacy_match_members (player_id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS legacy_match_members_room ON legacy_match_members(room_id);
            CREATE TABLE IF NOT EXISTS legacy_match_invites (
                recipient_id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL, inviter_id INTEGER NOT NULL,
                position INTEGER NOT NULL, target TEXT NOT NULL, created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL, status TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS legacy_match_invites_room ON legacy_match_invites(room_id);
        `)
    }
    roomFor(id) {
        ensure(playerId(id), 'Invalid team member identity', ErrorCode.GameConfig)
        const link = this.db.prepare('SELECT room_id FROM legacy_match_members WHERE player_id=?').get(id)
        if (!link) return null
        const row = this.db.prepare('SELECT payload FROM legacy_match_rooms WHERE id=?').get(link.room_id)
        ensure(row, 'Team membership references a missing room', ErrorCode.GameConfig)
        let room
        try {
            room = JSON.parse(row.payload)
        } catch {
            ensure(false, 'Invalid saved team payload', ErrorCode.GameConfig)
        }
        ensure(
            room?.schema_version === 1 &&
                room.id === link.room_id &&
                playerId(room.id) &&
                room.id <= MAX_ROOM_ID &&
                playerId(room.captain) &&
                uint(room.created_at) &&
                uint(room.revision) &&
                room.revision > 0 &&
                Array.isArray(room.members) &&
                room.members.length > 0 &&
                room.members.length <= MAX_MEMBERS &&
                room.members.every((member) => playerId(member.id) && uint(member.joined_at)) &&
                new Set(room.members.map((member) => member.id)).size === room.members.length &&
                room.members.some((member) => member.id === room.captain) &&
                room.members.some((member) => member.id === id) &&
                playerId(room.target?.dungeon_id) &&
                room.target.scene_type === 12 &&
                room.target.site_id === 0 &&
                Object.hasOwn(targetTables, room.target.kind) &&
                playerId(room.target.config_id),
            'Invalid saved team room',
            ErrorCode.GameConfig,
        )
        const members = this.db
            .prepare('SELECT player_id FROM legacy_match_members WHERE room_id=? ORDER BY player_id')
            .all(room.id)
            .map((member) => member.player_id)
        ensure(
            JSON.stringify(members) === JSON.stringify(room.members.map((member) => member.id).sort((a, b) => a - b)),
            'Team membership index disagrees with room',
            ErrorCode.GameConfig,
        )
        targetDefinition(this.tables, room.target)
        return room
    }
    snapshot(room, ownId, ownState) {
        const members = room.members.map((member) => {
            const state = member.id === ownId ? ownState : this.store.load(member.id).state
            return memberSnapshot(state, member.id, member.joined_at, this.tables)
        })
        return {
            team: {
                team_id: room.id,
                dungeon_id: room.target.dungeon_id,
                captain: room.captain,
                members,
                match_start_time: 0,
                ready_players: [],
                dungeon_end_time: '0',
                scene_type: room.target.scene_type,
                site_id: room.target.site_id,
                online_players: members
                    .filter((member) => member.pid === ownId || this.isOnline(member.pid))
                    .map((member) => member.pid),
            },
            reason: 0,
        }
    }
    create(c, r) {
        ensure(this.db.inTransaction, 'Team operation requires an atomic transaction', ErrorCode.GameConfig)
        ensure(!this.roomFor(c.id), 'Already in a legacy match team', ErrorCode.IsInMatchTeam)
        ensure(
            !c.state.entrust?.run &&
                !c.state.multiCampaign &&
                !c.state.storyCampaign &&
                !c.state.cultTrial &&
                !c.state.abyssRun,
            'Cannot create a team during a dungeon',
            ErrorCode.TeamInBattle,
        )
        const target = legacyMatchTarget(c, r)
        ensure(uint(c.now), 'Invalid team clock', ErrorCode.GameConfig)
        const allocated =
            this.db.prepare('SELECT value FROM sequences WHERE name=?').get('legacy-match-team')?.value ?? 0
        ensure(uint(allocated) && allocated < MAX_ROOM_ID, 'Team identity space is exhausted', ErrorCode.GameConfig)
        const id = this.store.nextSequence('legacy-match-team', MAX_ROOM_ID)
        const room = {
            schema_version: 1,
            id,
            captain: c.id,
            target,
            members: [{ id: c.id, joined_at: c.now }],
            created_at: c.now,
            revision: 1,
        }
        this.db.prepare('INSERT INTO legacy_match_rooms(id,payload) VALUES(?,?)').run(id, JSON.stringify(room))
        this.db.prepare('INSERT INTO legacy_match_members(player_id,room_id) VALUES(?,?)').run(c.id, id)
        this.db.prepare('DELETE FROM legacy_match_invites WHERE recipient_id=?').run(c.id)
        c.push('CSProtoMatchTeamDataSync', this.snapshot(room, c.id, c.state))
        return {}
    }
    loginSnapshot(id, state) {
        try {
            const room = this.roomFor(id)
            return room ? { ...this.snapshot(room, id, state), reason: 1 } : null
        } catch (error) {
            // Preserve a damaged optional room ledger for diagnosis without
            // turning an unrelated player's login into an unrecoverable loop.
            console.warn('[legacy-match-team] login snapshot omitted: ' + error.message)
            return null
        }
    }
    onLogin(id) {
        ensure(this.db.inTransaction, 'Invitation login cleanup requires a transaction', ErrorCode.GameConfig)
        //9521 has no expiry field and the new client would restart its full
        //30s animation. Never replay an old offer with a misleading countdown.
        this.db.prepare("DELETE FROM legacy_match_invites WHERE recipient_id=? AND status='pending'").run(id)
    }
    leave(c, r) {
        ensure(this.db.inTransaction, 'Team operation requires an atomic transaction', ErrorCode.GameConfig)
        ensure(uint(r.u32 ?? 0), 'Invalid leave team operation', ErrorCode.ReqParamsError)
        const room = this.roomFor(c.id)
        ensure(room, 'Not in a legacy match team', ErrorCode.NotInMatchTeam)
        const dismiss = (r.u32 ?? 0) !== 0
        ensure(!dismiss || room.captain === c.id, 'Only the captain can dismiss a team', ErrorCode.IsNotMatchTeamLeader)
        const notify = (recipient, name, value) => {
            if (recipient === c.id) c.push(name, value)
            else c.pushTo(recipient, name, value)
        }
        const previous = room.members.map((member) => member.id)
        // Old offers must not authorize joining a roster/captain that changed
        // after the actual invitation. The client closes its own30s window.
        this.db.prepare('DELETE FROM legacy_match_invites WHERE room_id=? OR recipient_id=?').run(room.id, c.id)
        if (dismiss || room.members.length === 1) {
            this.db.prepare('DELETE FROM legacy_match_members WHERE room_id=?').run(room.id)
            this.db.prepare('DELETE FROM legacy_match_rooms WHERE id=?').run(room.id)
            // TDR_NONE=0, not an invented timeout reason.9549 clears the UI
            // and invokes the caller's stored exit callback.
            for (const id of previous) notify(id, 'CSProtoTeamDimissSync', { reason: 0 })
        } else {
            room.members = room.members.filter((member) => member.id !== c.id)
            // LOCAL deterministic succession until an official rule is known:
            // the first remaining member in insertion order becomes captain.
            if (room.captain === c.id) room.captain = room.members[0].id
            ensure(room.revision < 0xffffffff, 'Team revision overflow', ErrorCode.GameConfig)
            room.revision++
            this.db.prepare('DELETE FROM legacy_match_members WHERE player_id=?').run(c.id)
            this.db.prepare('UPDATE legacy_match_rooms SET payload=? WHERE id=?').run(JSON.stringify(room), room.id)
            for (const id of previous)
                notify(id, 'CSProtoLeaveTeamSync', { player_id: c.id, new_captain: room.captain, reason: 0 })
            const snapshot = this.snapshot(room, c.id, c.state)
            for (const { id } of room.members) notify(id, 'CSProtoMatchTeamDataSync', snapshot)
        }
        return {}
    }
    invitationFor(id) {
        const row = this.db.prepare('SELECT * FROM legacy_match_invites WHERE recipient_id=?').get(id)
        if (!row) return null
        ensure(
            row.recipient_id === id &&
                playerId(row.inviter_id) &&
                playerId(row.room_id) &&
                row.room_id <= MAX_ROOM_ID &&
                uint(row.position) &&
                row.position < MAX_MEMBERS &&
                uint(row.created_at) &&
                uint(row.expires_at) &&
                row.expires_at > row.created_at &&
                ['pending', 'accepted', 'declined'].includes(row.status),
            'Invalid saved team invitation',
            ErrorCode.GameConfig,
        )
        let target
        try {
            target = JSON.parse(row.target)
        } catch {
            ensure(false, 'Invalid saved invitation target', ErrorCode.GameConfig)
        }
        ensure(
            target &&
                playerId(target.dungeon_id) &&
                target.scene_type === 12 &&
                target.site_id === 0 &&
                playerId(target.config_id) &&
                Object.hasOwn(targetTables, target.kind),
            'Invalid saved invitation target',
            ErrorCode.GameConfig,
        )
        return { ...row, target }
    }
    invitationWindow() {
        const policy = this.policy
        ensure(
            policy?.schema_version === 1 &&
                policy.invite_timeout_game_title === 'UI_TEAM_INVITATION_PLAYTIME' &&
                uint(policy.expected_client_window_seconds) &&
                policy.expected_client_window_seconds > 0,
            'Invalid LOCAL invitation expiry policy',
            ErrorCode.GameConfig,
        )
        const rows = this.tables.get('game').filter((row) => row.title === policy.invite_timeout_game_title)
        ensure(
            rows.length === 1 && /^\d+$/.test(String(rows[0].value)),
            'Team invitation duration configuration unavailable',
            ErrorCode.GameConfig,
        )
        const seconds = Number(rows[0].value)
        ensure(
            seconds === policy.expected_client_window_seconds,
            'Invitation table/window relation changed',
            ErrorCode.GameConfig,
        )
        return seconds
    }
    requireLobby(c, room) {
        for (const { id } of room.members) {
            const state = id === c.id ? c.state : this.store.load(id).state
            ensure(!busy(state), 'Team has a member in an active dungeon', ErrorCode.TeamInBattle)
        }
    }
    peerTarget(c, id, state, room) {
        try {
            const target = legacyMatchTarget({ ...c, id, state }, { ...room.target, dungeon_site: room.target.site_id })
            ensure(sameTarget(target, room.target), 'Team target relation changed', ErrorCode.TeamTargetChanged)
        } catch (error) {
            if (error.code === ErrorCode.EntrustUnlock) {
                const definition = targetDefinition(this.tables, room.target)
                const condition = String(room.target.kind === 'material' ? definition.unlock : definition.taskUnlock)
                const levelLocked = condition.split('|').some((token) => {
                    const [kind, level] = token.split('#').map(Number)
                    return kind === 2004 && state.player.basic_info.lv < level
                })
                throw new GameError(
                    'Invited player does not meet dungeon requirements',
                    levelLocked ? ErrorCode.TeamTargetLevelNotMet : ErrorCode.TargetUnlockSystem,
                )
            }
            if (error.code === ErrorCode.SystemLock)
                throw new GameError('Invited player system is locked', ErrorCode.TargetUnlockSystem)
            throw error
        }
    }
    inviteNotice(row, room, inviterState) {
        return {
            invite: {
                pid: row.inviter_id,
                team_id: String(row.room_id),
                dungeon_id: room.target.dungeon_id,
                name: Buffer.from(inviterState.player.basic_info.name, 'base64').toString('utf8'),
                scene_type: room.target.scene_type,
                cancel: false,
            },
        }
    }
    invite(c, r) {
        ensure(this.db.inTransaction, 'Team operation requires an atomic transaction', ErrorCode.GameConfig)
        ensure(
            playerId(r.pid) && uint(r.position ?? 0) && (r.position ?? 0) < MAX_MEMBERS,
            'Invalid team invitation target/position',
            ErrorCode.ReqParamsError,
        )
        ensure(r.pid !== c.id, 'Cannot invite yourself', ErrorCode.CannotOptYourSelf)
        // Current ReqInvitePlayer sends false. is_quit is not proven to mean
        // cancel; do not reinterpret it as a destructive operation.
        ensure(!r.is_quit, 'Legacy invitation is_quit behavior is not implemented', ErrorCode.FunctionClosed)
        const room = this.roomFor(c.id)
        ensure(room, 'Not in a legacy match team', ErrorCode.NotInMatchTeam)
        // LOCAL permission policy until the old Lua UI/official rule is
        // confirmed. Both captain-only and ordinary-member invites are
        // supported; do not describe this default as verified official law.
        ensure(
            ['captain', 'members'].includes(this.policy?.invite_permission),
            'Invalid LOCAL invitation permission policy',
            ErrorCode.GameConfig,
        )
        if (this.policy.invite_permission === 'captain')
            ensure(room.captain === c.id, 'Only the captain can invite', ErrorCode.IsNotMatchTeamLeader)
        ensure(
            r.dungeon_id === room.target.dungeon_id,
            'Invitation target no longer matches the team',
            ErrorCode.TeamTargetChanged,
        )
        this.requireLobby(c, room)
        ensure(this.store.hasPlayer(r.pid), 'Invited player does not exist', ErrorCode.InvalidTarget)
        ensure(!this.roomFor(r.pid), 'Invited player is already in a team', ErrorCode.InvitedMemberInMatchTeam)
        ensure(this.isOnline(r.pid), 'Invited player is offline', ErrorCode.PlayerNotOnline)
        const peer = this.store.load(r.pid).state
        ensure(!legacyChatBans(c.state).has(r.pid), 'Inviter has blocked the target', ErrorCode.YouBanTarget)
        ensure(!legacyChatBans(peer).has(c.id), 'Invited player has blocked the inviter', ErrorCode.TargetBanYou)
        ensure(!busy(peer), 'Invited player is busy', ErrorCode.TargetBusy)
        this.peerTarget(c, r.pid, peer, room)
        const seconds = this.invitationWindow()
        ensure(uint(c.now) && c.now <= 0xffffffff - seconds, 'Invalid team invitation clock', ErrorCode.GameConfig)
        const prior = this.invitationFor(r.pid)
        if (prior?.status === 'pending' && prior.expires_at > c.now) {
            ensure(
                prior.room_id === room.id && prior.inviter_id === c.id && sameTarget(prior.target, room.target),
                'Player has another pending team invitation',
                ErrorCode.TargetBeingInvited,
            )
            // Do not restart the client's30s timer or extend server expiry.
            return {}
        }
        const reserved = this.db
            .prepare(
                "SELECT count(*) AS n FROM legacy_match_invites WHERE room_id=? AND status='pending' AND expires_at>?",
            )
            .get(room.id, c.now).n
        ensure(room.members.length < MAX_MEMBERS, 'Team is full', ErrorCode.ExceedMatchTeamPlayerNum)
        ensure(
            room.members.length + reserved < MAX_MEMBERS,
            'All remaining team places are invited',
            ErrorCode.InviteMatchTeamNumLimit,
        )
        const row = {
            recipient_id: r.pid,
            room_id: room.id,
            inviter_id: c.id,
            position: r.position ?? 0,
            target: JSON.stringify(room.target),
            created_at: c.now,
            expires_at: c.now + seconds,
            status: 'pending',
        }
        this.db
            .prepare(
                `INSERT INTO legacy_match_invites(recipient_id,room_id,inviter_id,position,target,created_at,expires_at,status)
            VALUES(@recipient_id,@room_id,@inviter_id,@position,@target,@created_at,@expires_at,@status)
            ON CONFLICT(recipient_id) DO UPDATE SET room_id=excluded.room_id,inviter_id=excluded.inviter_id,position=excluded.position,
            target=excluded.target,created_at=excluded.created_at,expires_at=excluded.expires_at,status=excluded.status`,
            )
            .run(row)
        c.pushTo(r.pid, 'CSProtoInviteDataSync', this.inviteNotice(row, room, c.state))
        return {}
    }
    replyInvitation(c, r) {
        ensure(this.db.inTransaction, 'Team operation requires an atomic transaction', ErrorCode.GameConfig)
        const value = r.invite_id
        ensure(
            (typeof value === 'string' || Number.isSafeInteger(value)) &&
                /^(0|[1-9]\d*)$/.test(String(value)) &&
                String(value).length <= 20 &&
                BigInt(value) > 0n &&
                BigInt(value) <= BigInt(MAX_ROOM_ID),
            'Invalid invitation room identity',
            ErrorCode.ReqParamsError,
        )
        const id = Number(value),
            accepted = r.is_accept ?? false,
            offer = this.invitationFor(c.id)
        ensure(typeof accepted === 'boolean', 'Invalid invitation reply', ErrorCode.ReqParamsError)
        ensure(offer && offer.room_id === id, 'No invitation for this player and room', ErrorCode.NotInviteMatchTeam)
        ensure(
            !r.dungeon_id || r.dungeon_id === offer.target.dungeon_id,
            'Invitation target does not match',
            ErrorCode.TeamTargetChanged,
        )
        if (offer.status !== 'pending') {
            if (offer.status === 'declined' && !accepted) return {}
            const member = this.roomFor(c.id)
            ensure(
                accepted && offer.status === 'accepted' && member?.id === id,
                'Invitation was already handled',
                member ? ErrorCode.IsInMatchTeam : ErrorCode.NotInviteMatchTeam,
            )
            // A known accepted receipt is replayed as the current snapshot;
            // never insert a second member or re-run the admission transition.
            c.push('CSProtoMatchTeamDataSync', this.snapshot(member, c.id, c.state))
            return {}
        }
        ensure(uint(c.now) && c.now >= offer.created_at, 'Invalid invitation reply clock', ErrorCode.GameConfig)
        ensure(c.now < offer.expires_at, 'Invitation expired', ErrorCode.InviteMatchTeamExpired)
        const room = this.roomFor(offer.inviter_id)
        ensure(room && room.id === id, 'Invited team no longer exists', ErrorCode.TeamNotExists)
        ensure(sameTarget(room.target, offer.target), 'Invited team target changed', ErrorCode.TeamTargetChanged)
        if (!accepted) {
            this.db.prepare("UPDATE legacy_match_invites SET status='declined' WHERE recipient_id=?").run(c.id)
            c.pushTo(offer.inviter_id, 'CSProtoRejectInviteJoin', {
                pid: c.id,
                name: Buffer.from(c.state.player.basic_info.name, 'base64').toString('utf8'),
            })
            return {}
        }
        ensure(!this.roomFor(c.id), 'Already accepted another team invitation', ErrorCode.HaveInvitedAccepted)
        ensure(this.isOnline(offer.inviter_id), 'Inviting player is offline', ErrorCode.PlayerNotOnline)
        this.requireLobby(c, room)
        ensure(!busy(c.state), 'Cannot join a team during a dungeon', ErrorCode.CannotMatch)
        const inviter = this.store.load(offer.inviter_id).state
        ensure(
            !legacyChatBans(c.state).has(offer.inviter_id),
            'Invitee has blocked the inviter',
            ErrorCode.YouBanTarget,
        )
        ensure(!legacyChatBans(inviter).has(c.id), 'Inviter has blocked the invitee', ErrorCode.TargetBanYou)
        this.peerTarget(c, c.id, c.state, room)
        ensure(room.members.length < MAX_MEMBERS, 'Team became full', ErrorCode.ExceedMatchTeamPlayerNum)
        ensure(room.revision < 0xffffffff, 'Team revision overflow', ErrorCode.GameConfig)
        room.members.push({ id: c.id, joined_at: c.now })
        room.revision++
        this.db.prepare('INSERT INTO legacy_match_members(player_id,room_id) VALUES(?,?)').run(c.id, room.id)
        this.db.prepare('UPDATE legacy_match_rooms SET payload=? WHERE id=?').run(JSON.stringify(room), room.id)
        this.db.prepare("UPDATE legacy_match_invites SET status='accepted' WHERE recipient_id=?").run(c.id)
        const snapshot = this.snapshot(room, c.id, c.state)
        c.push('CSProtoMatchTeamDataSync', snapshot)
        for (const member of room.members)
            if (member.id !== c.id) c.pushTo(member.id, 'CSProtoMatchTeamDataSync', snapshot)
        return {}
    }
}

export function registerLegacyMatchTeams(on, store, tables) {
    const teams = new LegacyMatchTeams(store, tables)
    on('CreateMatchTeam', (c, r) => teams.create(c, r))
    on('LeaveMatchTeam', (c, r) => teams.leave(c, r))
    on('InviteJoin', (c, r) => teams.invite(c, r))
    on('ReplyInviteJoin', (c, r) => teams.replyInvitation(c, r))
    return teams
}
