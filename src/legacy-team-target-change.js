import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const sameTarget = (a, b) =>
    ['dungeon_id', 'scene_type', 'site_id', 'kind', 'config_id'].every((key) => a?.[key] === b?.[key])
const sameMembers = (room, p) =>
    JSON.stringify(room.members.map((member) => member.id)) ===
    JSON.stringify(p.participants.map((member) => member.id))

export class LegacyTeamTargetChanges {
    constructor(teams, resolveTarget, encodeNotice) {
        this.teams = teams
        this.db = teams.db
        this.resolveTarget = resolveTarget
        this.encodeNotice = encodeNotice
        this.db.exec(`CREATE TABLE IF NOT EXISTS legacy_match_target_changes (
            room_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL
        ); CREATE INDEX IF NOT EXISTS legacy_match_target_expiry ON legacy_match_target_changes(status,expires_at);`)
    }
    get(roomId) {
        const row = this.db.prepare('SELECT * FROM legacy_match_target_changes WHERE room_id=?').get(roomId)
        if (!row) return null
        let p
        try {
            p = JSON.parse(row.payload)
        } catch {
            ensure(false, 'Invalid saved target proposal', ErrorCode.GameConfig)
        }
        ensure(
            p?.version === 1 &&
                p.room_id === roomId &&
                positive(p.epoch) &&
                positive(p.room_revision) &&
                positive(p.proposer_id) &&
                ['pending', 'committed', 'declined', 'expired', 'cancelled'].includes(p.status) &&
                row.status === p.status &&
                row.expires_at === p.expires_at &&
                uint(p.created_at) &&
                uint(p.expires_at) &&
                p.expires_at - p.created_at === 15 &&
                Array.isArray(p.participants) &&
                p.participants.length >= 1 &&
                p.participants.length <= 3 &&
                p.participants.every(
                    (member) =>
                        positive(member.id) &&
                        typeof member.connection === 'string' &&
                        member.connection.length > 0 &&
                        member.connection.length <= 256,
                ) &&
                new Set(p.participants.map((member) => member.id)).size === p.participants.length &&
                Array.isArray(p.votes) &&
                p.votes.every(
                    (vote) =>
                        typeof vote.accept === 'boolean' && p.participants.some((member) => member.id === vote.id),
                ) &&
                new Set(p.votes.map((vote) => vote.id)).size === p.votes.length &&
                p.votes.some((vote) => vote.id === p.proposer_id && vote.accept) &&
                (p.status === 'pending' || uint(p.closed_at)),
            'Invalid saved target proposal ledger',
            ErrorCode.GameConfig,
        )
        this.teams.validateTarget(p.old_target)
        this.teams.validateTarget(p.target)
        return p
    }
    save(p) {
        ensure(this.db.inTransaction, 'Target proposal needs an atomic transaction', ErrorCode.GameConfig)
        this.db
            .prepare(
                `INSERT INTO legacy_match_target_changes(room_id,payload,status,expires_at) VALUES(?,?,?,?)
            ON CONFLICT(room_id) DO UPDATE SET payload=excluded.payload,status=excluded.status,expires_at=excluded.expires_at`,
            )
            .run(p.room_id, JSON.stringify(p), p.status, p.expires_at)
    }
    notify(c, recipients, name, data) {
        for (const member of recipients) {
            const id = typeof member === 'number' ? member : member.id
            if (id === c.id) c.push(name, data)
            else c.pushTo(id, name, data)
        }
    }
    connectionsMatch(p) {
        return p.participants.every(
            (member) => this.teams.isOnline(member.id) && this.teams.connectionKey(member.id) === member.connection,
        )
    }
    contextMatches(room, p) {
        return (
            room.id === p.room_id &&
            room.revision === p.room_revision &&
            room.captain === p.proposer_id &&
            sameMembers(room, p) &&
            sameTarget(room.target, p.old_target) &&
            this.connectionsMatch(p)
        )
    }
    close(c, room, p, status) {
        if (p.status !== 'pending') return
        p.status = status
        p.closed_at = c.now
        this.save(p)
        this.notify(c, p.participants, 'CSProtoChangeDungeonSync', {
            dungeon_id: room.target.dungeon_id,
            ask: false,
            player_id: p.proposer_id,
            cancel: true,
        })
    }
    cancel(c, room) {
        const p = this.get(room.id)
        if (p?.status === 'pending') this.close(c, room, p, 'cancelled')
    }
    hasPending(roomId, now) {
        const p = this.get(roomId)
        return !!(p?.status === 'pending' && now < p.expires_at)
    }
    checkEligibility(c, room, target) {
        this.teams.requireLobby(c, room)
        for (const member of room.members) {
            ensure(this.teams.isOnline(member.id), 'A team participant is offline', ErrorCode.PlayerNotOnline)
            const state = member.id === c.id ? c.state : this.teams.store.load(member.id).state
            this.teams.peerTarget(c, member.id, state, { ...room, target })
        }
    }
    commit(c, room, p) {
        ensure(
            p.status === 'pending' && this.contextMatches(room, p),
            'Team proposal context changed',
            ErrorCode.TeamTargetChanged,
        )
        ensure(
            p.participants.every((member) => p.votes.some((vote) => vote.id === member.id && vote.accept)),
            'Wait for all team decisions',
            ErrorCode.TeamWaitStateSync,
        )
        this.checkEligibility(c, room, p.target)
        ensure(room.revision < 0xffffffff, 'Team revision overflow', ErrorCode.GameConfig)
        room.target = { ...p.target }
        room.revision++
        this.db.prepare('UPDATE legacy_match_rooms SET payload=? WHERE id=?').run(JSON.stringify(room), room.id)
        this.db.prepare("DELETE FROM legacy_match_invites WHERE room_id=? AND status='pending'").run(room.id)
        p.status = 'committed'
        p.closed_at = c.now
        this.save(p)
        this.notify(c, p.participants, 'CSProtoChangeDungeonSync', {
            dungeon_id: room.target.dungeon_id,
            ask: false,
            player_id: p.proposer_id,
            cancel: false,
        })
        this.notify(c, p.participants, 'CSProtoMatchTeamDataSync', this.teams.snapshot(room, c.id, c.state))
    }
    change(c, r) {
        ensure(this.db.inTransaction, 'Target change needs an atomic transaction', ErrorCode.GameConfig)
        ensure(uint(c.now), 'Invalid target proposal clock', ErrorCode.GameConfig)
        const room = this.teams.roomFor(c.id)
        ensure(room, 'Not in a legacy match team', ErrorCode.NotInMatchTeam)
        ensure(room.captain === c.id, 'Only the captain can propose/commit a target', ErrorCode.IsNotMatchTeamLeader)
        ensure(!r.random && !r.cancel, 'Random/cancel target request is not implemented', ErrorCode.FunctionClosed)
        let p = this.get(room.id)
        if (!(r.scene_type ?? 0)) {
            // The real client's final9536 encodes ChangeDungeonSync.ask=false
            // instead of CSCreateMatchTeam.scene_type; its wire field2 is0.
            ensure(
                !r.dungeon_site && positive(r.dungeon_id),
                'Invalid target commit parameters',
                ErrorCode.ReqParamsError,
            )
            if (
                p?.status === 'committed' &&
                p.target.dungeon_id === r.dungeon_id &&
                sameTarget(room.target, p.target)
            ) {
                c.push('CSProtoMatchTeamDataSync', this.teams.snapshot(room, c.id, c.state))
                return {}
            }
            if (p && p.status !== 'pending' && p.proposer_id === c.id && p.target.dungeon_id === r.dungeon_id) {
                c.push('CSProtoChangeDungeonSync', {
                    dungeon_id: room.target.dungeon_id,
                    ask: false,
                    player_id: c.id,
                    cancel: true,
                })
                c.push('CSProtoMatchTeamDataSync', this.teams.snapshot(room, c.id, c.state))
                return {}
            }
            ensure(p?.status === 'pending', 'No active target proposal', ErrorCode.ReqParamsError)
            ensure(
                p.target.dungeon_id === r.dungeon_id,
                'Target commit does not match the proposal',
                ErrorCode.TeamTargetChanged,
            )
            if (c.now >= p.expires_at || !this.contextMatches(room, p)) {
                this.close(c, room, p, c.now >= p.expires_at ? 'expired' : 'cancelled')
                return {}
            }
            ensure(
                this.teams.connectionKey(c.id) === c.combatSessionId,
                'Proposal owner connection changed',
                ErrorCode.TeamTargetChanged,
            )
            this.commit(c, room, p)
            return {}
        }
        const target = this.resolveTarget(c, r)
        ensure(
            target.scene_type === room.target.scene_type,
            'Cannot change a team into another scene family',
            ErrorCode.FunctionClosed,
        )
        if (p?.status === 'pending' && (c.now >= p.expires_at || !this.contextMatches(room, p))) {
            this.close(c, room, p, c.now >= p.expires_at ? 'expired' : 'cancelled')
            p = null
        }
        if (p?.status === 'pending') {
            ensure(sameTarget(p.target, target), 'Another team proposal is still pending', ErrorCode.TeamWaitStateSync)
            // ReqChangeLevelId resets the captain's local accepted map. Replay
            // known decisions to it without restarting anyone else's dialog.
            for (const vote of p.votes)
                if (vote.id !== c.id && vote.accept)
                    c.push('CSProtoReplyChangeDungeonNtf', { player_id: vote.id, accept: true })
            return {}
        }
        if (sameTarget(room.target, target)) {
            c.push('CSProtoMatchTeamDataSync', this.teams.snapshot(room, c.id, c.state))
            return {}
        }
        this.checkEligibility(c, room, target)
        const window = this.teams.policy.change_window_seconds
        ensure(
            positive(window) && window === 15 && c.now <= 0xffffffff - window,
            'Invalid LOCAL target proposal window',
            ErrorCode.GameConfig,
        )
        const participants = room.members.map((member) => ({
            id: member.id,
            connection: this.teams.connectionKey(member.id),
        }))
        ensure(
            participants.every(
                (member) =>
                    typeof member.connection === 'string' &&
                    member.connection.length > 0 &&
                    member.connection.length <= 256,
            ),
            'Live participant connection context unavailable',
            ErrorCode.GameConfig,
        )
        ensure(
            participants.find((member) => member.id === c.id).connection === c.combatSessionId,
            'Proposal owner connection changed',
            ErrorCode.TeamTargetChanged,
        )
        const seq = this.db.prepare('SELECT value FROM sequences WHERE name=?').get('legacy-match-change')?.value ?? 0
        ensure(uint(seq) && seq < 0xffffffff, 'Target proposal identity space exhausted', ErrorCode.GameConfig)
        p = {
            version: 1,
            epoch: this.teams.store.nextSequence('legacy-match-change'),
            room_id: room.id,
            room_revision: room.revision,
            proposer_id: c.id,
            old_target: { ...room.target },
            target,
            participants,
            votes: [{ id: c.id, accept: true }],
            created_at: c.now,
            expires_at: c.now + window,
            status: 'pending',
        }
        this.save(p)
        this.db.prepare("DELETE FROM legacy_match_invites WHERE room_id=? AND status='pending'").run(room.id)
        if (participants.length === 1) this.commit(c, room, p)
        else
            this.notify(c, participants, 'CSProtoChangeDungeonSync', {
                dungeon_id: target.dungeon_id,
                ask: true,
                player_id: c.id,
                cancel: false,
            })
        return {}
    }
    vote(c, r) {
        ensure(this.db.inTransaction, 'Target vote needs an atomic transaction', ErrorCode.GameConfig)
        const room = this.teams.roomFor(c.id)
        ensure(room, 'Not in a legacy match team', ErrorCode.NotInMatchTeam)
        const p = this.get(room.id),
            accept = r.accept ?? false
        ensure(
            p && p.participants.some((member) => member.id === c.id),
            'No target proposal for this participant',
            ErrorCode.ReqParamsError,
        )
        ensure(typeof accept === 'boolean', 'Invalid target decision', ErrorCode.ReqParamsError)
        ensure(
            !r.dungeon_id || r.dungeon_id === p.target.dungeon_id,
            'Decision target does not match the proposal',
            ErrorCode.TeamTargetChanged,
        )
        if (p.status !== 'pending') return {} // Real closed receipt; no decision/target is changed.
        ensure(uint(c.now), 'Invalid target decision clock', ErrorCode.GameConfig)
        if (c.now >= p.expires_at || !this.contextMatches(room, p)) {
            this.close(c, room, p, c.now >= p.expires_at ? 'expired' : 'cancelled')
            return {}
        }
        const member = p.participants.find((member) => member.id === c.id)
        ensure(member.connection === c.combatSessionId, 'Participant connection changed', ErrorCode.TeamTargetChanged)
        const previous = p.votes.find((vote) => vote.id === c.id)
        if (previous) {
            // Current UI permits one choice; an already recorded decision is
            // not reversed by a duplicate/late timer callback.
            if (previous.accept === accept && accept)
                this.notify(c, [p.proposer_id], 'CSProtoReplyChangeDungeonNtf', { player_id: c.id, accept: true })
            return {}
        }
        p.votes.push({ id: c.id, accept })
        // Only the initiating captain initialized targetDungeonId and its
        // local accepted-map. Broadcasting9548 to others can make them send
        // a final9536 with an uninitialized or stale target.
        this.notify(c, [p.proposer_id], 'CSProtoReplyChangeDungeonNtf', { player_id: c.id, accept })
        if (accept) this.save(p)
        else this.close(c, room, p, 'declined')
        return {}
    }
    maintenance(now, roomId) {
        ensure(uint(now), 'Invalid target maintenance clock', ErrorCode.GameConfig)
        const rows =
            roomId === undefined
                ? this.db
                      .prepare(
                          "SELECT room_id FROM legacy_match_target_changes WHERE status='pending' AND expires_at<=?",
                      )
                      .all(now)
                : [{ room_id: roomId }]
        if (!rows.length) return []
        return this.db
            .transaction(() => {
                const packets = [],
                    context = {
                        id: 0,
                        now,
                        pushTo: (recipient, name, data) => packets.push(this.encodeNotice(name, data, recipient)),
                    }
                for (const row of rows) {
                    const p = this.get(row.room_id)
                    if (p?.status !== 'pending') continue
                    const room = this.teams.roomFor(p.proposer_id)
                    ensure(room?.id === p.room_id, 'Pending proposal room is unavailable', ErrorCode.GameConfig)
                    if (now >= p.expires_at || !this.contextMatches(room, p))
                        this.close(context, room, p, now >= p.expires_at ? 'expired' : 'cancelled')
                }
                return packets
            })
            .immediate()
    }
}
