import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { teamV2Target } from './team-v2-eligibility.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const clone = (value) => structuredClone(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const targetShape = (value) =>
    value && positive(value.dungeon_system_id) && Object.keys(value).every((key) => key === 'dungeon_system_id')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const phases = new Set(['pending', 'committed', 'declined', 'expired', 'cancelled', 'check_failed'])
const eligibilityErrors = new Set([
    ErrorCode.SystemLock,
    ErrorCode.EntrustUnlock,
    ErrorCode.TeamInBattle,
    ErrorCode.CannotMatch,
    ErrorCode.PlayerNotOnline,
    ErrorCode.TeamTargetLevelNotMet,
])
const milliseconds = (seconds) => {
    ensure(uint(seconds), 'Invalid TeamV2 proposal clock', ErrorCode.GameConfig)
    return seconds * 1000
}

// Target selection is a lobby overlay, not a new TeamV2State or dungeon entry.
// The current client has no final legacy9536 commit: the last actual acceptance
// completes the proposal. The captain cannot vote through the peer dialog.
export class TeamV2TargetChanges {
    constructor(teams) {
        this.teams = teams
        this.db = teams.db
        this.db.exec(`CREATE TABLE IF NOT EXISTS team_v2_target_changes(
            team_id INTEGER PRIMARY KEY,status TEXT NOT NULL,expires_at_ms INTEGER NOT NULL,payload TEXT NOT NULL
        ); CREATE INDEX IF NOT EXISTS team_v2_target_change_expiry ON team_v2_target_changes(status,expires_at_ms);`)
    }
    windowMs() {
        const rows = this.teams.tables.get('game').filter((row) => row.title === 'MULTI_CHANGE_TARGET_CD')
        ensure(
            rows.length === 1 && rows[0].type === 'int' && /^[1-9]\d*$/.test(rows[0].value),
            'TeamV2 target window configuration is unavailable',
            ErrorCode.GameConfig,
        )
        const duration = Number(rows[0].value) * 1000
        ensure(
            Number.isSafeInteger(duration) && duration <= 0x7fffffff,
            'Invalid TeamV2 target window',
            ErrorCode.GameConfig,
        )
        return duration
    }
    get(teamId) {
        const row = this.db.prepare('SELECT * FROM team_v2_target_changes WHERE team_id=?').get(Number(teamId))
        if (!row) return null
        let proposal
        try {
            proposal = JSON.parse(row.payload)
        } catch {
            ensure(false, 'Malformed TeamV2 target proposal JSON', ErrorCode.GameConfig)
        }
        const p = proposal
        ensure(
            p?.version === 1 &&
                p.team_id === String(row.team_id) &&
                [101, 500, 1].includes(p.typ) &&
                targetShape(p.old_target) &&
                targetShape(p.target) &&
                positive(p.epoch) &&
                positive(p.proposer_id) &&
                phases.has(p.status) &&
                p.status === row.status &&
                p.expires_at_ms === row.expires_at_ms &&
                Number.isSafeInteger(p.created_at_ms) &&
                p.created_at_ms >= 0 &&
                Number.isSafeInteger(p.window_ms) &&
                p.window_ms > 0 &&
                p.window_ms <= 0x7fffffff &&
                p.expires_at_ms === p.created_at_ms + p.window_ms &&
                Array.isArray(p.participants) &&
                p.participants.length >= 1 &&
                p.participants.length <= 3 &&
                p.participants.every(
                    (m) =>
                        m &&
                        positive(m.id) &&
                        positive(m.lease) &&
                        Number.isInteger(m.site) &&
                        m.site >= 1 &&
                        m.site <= 3 &&
                        /^[a-f0-9]{64}$/.test(m.connection_hash),
                ) &&
                new Set(p.participants.map((m) => m.id)).size === p.participants.length &&
                new Set(p.participants.map((m) => m.site)).size === p.participants.length &&
                new Set(p.participants.map((m) => m.lease)).size === p.participants.length &&
                p.participants.some((m) => m.id === p.proposer_id) &&
                Array.isArray(p.votes) &&
                p.votes.every(
                    (vote) => vote && typeof vote.accept === 'boolean' && p.participants.some((m) => m.id === vote.id),
                ) &&
                new Set(p.votes.map((vote) => vote.id)).size === p.votes.length &&
                p.votes.some((vote) => vote.id === p.proposer_id && vote.accept) &&
                (p.status !== 'pending' || p.votes.every((vote) => vote.accept)) &&
                (p.status !== 'committed' ||
                    (p.votes.length === p.participants.length && p.votes.every((vote) => vote.accept))) &&
                (p.status === 'pending' || (Number.isSafeInteger(p.closed_at_ms) && p.closed_at_ms >= p.created_at_ms)),
            'Saved TeamV2 proposal is malformed',
            ErrorCode.GameConfig,
        )
        // Closed proposals are historical receipts, not current eligibility.
        // A removed old row must not block an unrelated current lobby action.
        if (p.status === 'pending') {
            teamV2Target(this.teams.tables, p.typ, p.old_target)
            teamV2Target(this.teams.tables, p.typ, p.target)
        }
        return p
    }
    save(p) {
        this.teams.requireTransaction()
        this.db
            .prepare(
                'INSERT INTO team_v2_target_changes(team_id,status,expires_at_ms,payload)VALUES(?,?,?,?)ON CONFLICT(team_id)DO UPDATE SET status=excluded.status,expires_at_ms=excluded.expires_at_ms,payload=excluded.payload',
            )
            .run(Number(p.team_id), p.status, p.expires_at_ms, JSON.stringify(p))
    }
    participants(room) {
        return [...room.members]
            .sort((a, b) => a.site - b.site)
            .map((member) => {
                const key = this.teams.connectionKey(member.id)
                ensure(this.teams.isOnline(member.id), 'TeamV2 participant is offline', ErrorCode.PlayerNotOnline)
                ensure(
                    typeof key === 'string' && key.length > 0 && key.length <= 256,
                    'TeamV2 participant connection is unavailable',
                    ErrorCode.GameConfig,
                )
                return { id: member.id, site: member.site, lease: member.lease, connection_hash: hash(key) }
            })
    }
    contextMatches(room, p) {
        // Public member-data updates may advance room.revision. Authority is
        // captain + typed target + ordered entry leases and live connections.
        return (
            room.id === p.team_id &&
            room.state === 1 &&
            room.captain === p.proposer_id &&
            room.typ === p.typ &&
            same(room.target, p.old_target) &&
            same(
                [...room.members].sort((a, b) => a.site - b.site).map(({ id, site, lease }) => ({ id, site, lease })),
                p.participants.map(({ id, site, lease }) => ({ id, site, lease })),
            ) &&
            p.participants.every((member) => {
                const key = this.teams.connectionKey(member.id)
                return this.teams.isOnline(member.id) && typeof key === 'string' && hash(key) === member.connection_hash
            })
        )
    }
    requireProjection(room, p) {
        ensure(
            same(room.change_target, p.target) &&
                room.change_vote_time === p.created_at_ms &&
                same(
                    room.change_vote,
                    p.votes.filter((vote) => vote.accept).map((vote) => vote.id),
                ),
            'TeamV2 proposal projection differs from its ledger',
            ErrorCode.GameConfig,
        )
    }
    requireCaller(c, p) {
        const key = this.teams.connectionKey(c.id),
            member = p.participants.find((entry) => entry.id === c.id)
        ensure(
            member && typeof key === 'string' && key === c.combatSessionId && member.connection_hash === hash(key),
            'TeamV2 proposal caller connection changed',
            ErrorCode.TeamTargetChanged,
        )
    }
    checks(c, room, target) {
        const failures = []
        for (const member of room.members) {
            try {
                ensure(this.teams.isOnline(member.id), 'TeamV2 participant is offline', ErrorCode.PlayerNotOnline)
                const state = this.teams.readState(c, member.id)
                this.teams.requireLobby(c, state)
                this.teams.requireTarget(c, { typ: room.typ, target }, member.id, state)
            } catch (error) {
                // Unknown/configuration/integrity failures must not become a
                // player-ineligible result or silently commit another target.
                if (!eligibilityErrors.has(error.code)) throw error
                failures.push({ player_id: member.id, code: error.code })
            }
        }
        return failures
    }
    close(c, room, p, status, { playerId = 0, checkList = [] } = {}) {
        if (p.status !== 'pending') return room
        p.status = status
        p.closed_at_ms = milliseconds(c.now)
        ensure(p.closed_at_ms >= p.created_at_ms, 'TeamV2 proposal clock moved backwards', ErrorCode.GameConfig)
        this.save(p)
        if (status === 'committed') {
            room.target = clone(p.target)
            this.db
                .prepare("UPDATE team_v2_invites SET status='cancelled' WHERE team_id=? AND status='pending'")
                .run(Number(room.id))
        }
        delete room.change_target
        delete room.change_vote
        delete room.change_vote_time
        const options = {
            playerId,
            checkList,
            onlineOverride: new Map(room.members.map((m) => [m.id, this.teams.isOnline(m.id)])),
        }
        // Current13/14/15 copy only the change fields. Full0 must first install
        // the canonical new/retained target in CurTeam; then emit the outcome.
        const saved = this.teams.commitRoom(c, room, 0, options)
        this.teams.publish(c, saved, status === 'committed' ? 13 : status === 'check_failed' ? 15 : 14, options)
        return saved
    }
    reconcile(c, room) {
        const p = this.get(room.id)
        if (!p || p.status !== 'pending') {
            ensure(!room.change_target, 'TeamV2 target projection has no pending ledger', ErrorCode.GameConfig)
            return room
        }
        this.requireProjection(room, p)
        const now = milliseconds(c.now)
        ensure(now >= p.created_at_ms, 'TeamV2 proposal clock moved backwards', ErrorCode.GameConfig)
        if (now >= p.expires_at_ms) return this.close(c, room, p, 'expired')
        if (!this.contextMatches(room, p)) return this.close(c, room, p, 'cancelled')
        return room
    }
    cancel(c, room, playerId = c.id) {
        const p = this.get(room.id)
        if (p?.status !== 'pending') return room
        this.requireProjection(room, p)
        return this.close(c, room, p, 'cancelled', { playerId })
    }
    propose(c, request) {
        this.teams.requireTransaction()
        let room = this.teams.requireRoom(c, request.team_id, { captain: true })
        this.teams.requireNormal(room, { allowTargetChange: true })
        room = this.reconcile(c, room)
        const { target } = teamV2Target(c.tables, room.typ, request.target),
            prior = this.get(room.id)
        if (prior?.status === 'pending') {
            ensure(same(prior.target, target), 'Another TeamV2 target proposal is pending', ErrorCode.TeamWaitStateSync)
            this.requireCaller(c, prior)
            this.teams.notify(c, c.id, 'CSProtoTeamV2TeamUpdateNotify', {
                reason: 0,
                team: this.teams.snapshot(c, room),
            })
            return room
        }
        if (same(room.target, target)) {
            this.teams.notify(c, c.id, 'CSProtoTeamV2TeamUpdateNotify', {
                reason: 0,
                team: this.teams.snapshot(c, room),
            })
            return room
        }
        const failures = this.checks(c, room, target)
        ensure(
            failures.length === 0,
            'A TeamV2 member cannot use the proposed target',
            failures[0]?.code ?? ErrorCode.GameConfig,
        )
        const created = milliseconds(c.now),
            window = this.windowMs(),
            participants = this.participants(room)
        const sequence = this.db.prepare('SELECT value FROM sequences WHERE name=?').get('team_v2_change')?.value ?? 0
        ensure(uint(sequence) && sequence < 0xffffffff, 'TeamV2 proposal identity exhausted', ErrorCode.GameConfig)
        const p = {
            version: 1,
            team_id: room.id,
            typ: room.typ,
            epoch: this.teams.store.nextSequence('team_v2_change', 0xffffffff),
            proposer_id: c.id,
            old_target: clone(room.target),
            target: clone(target),
            participants,
            votes: [{ id: c.id, accept: true }],
            status: 'pending',
            created_at_ms: created,
            window_ms: window,
            expires_at_ms: created + window,
        }
        this.requireCaller(c, p)
        this.save(p)
        if (participants.length === 1) return this.close(c, room, p, 'committed', { playerId: c.id })
        room.change_target = clone(target)
        room.change_vote = [c.id]
        room.change_vote_time = created
        const saved = this.teams.commitRoom(c, room, 0)
        this.teams.publish(c, saved, 11, { playerId: c.id })
        return saved
    }
    vote(c, request) {
        this.teams.requireTransaction()
        let room = this.teams.requireRoom(c, request.team_id)
        this.teams.requireNormal(room, { allowTargetChange: true })
        let p = this.get(room.id)
        const accept = request.accept ?? false
        ensure(typeof accept === 'boolean', 'Invalid TeamV2 target vote', ErrorCode.ReqParamsError)
        ensure(
            p && p.participants.some((m) => m.id === c.id),
            'No TeamV2 proposal for this member',
            ErrorCode.ReqParamsError,
        )
        if (p.status !== 'pending') {
            this.teams.notify(c, c.id, 'CSProtoTeamV2TeamUpdateNotify', {
                reason: 0,
                team: this.teams.snapshot(c, room),
            })
            return room
        }
        const before = room.revision
        room = this.reconcile(c, room)
        if (room.revision !== before) return room
        this.requireCaller(c, p)
        const previous = p.votes.find((vote) => vote.id === c.id)
        if (previous) {
            this.teams.notify(c, c.id, 'CSProtoTeamV2TeamUpdateNotify', {
                reason: 0,
                team: this.teams.snapshot(c, room),
            })
            return room
        }
        p.votes.push({ id: c.id, accept })
        if (!accept) return this.close(c, room, p, 'declined', { playerId: c.id })
        if (p.votes.length === p.participants.length) {
            const failures = this.checks(c, room, p.target)
            return this.close(c, room, p, failures.length ? 'check_failed' : 'committed', {
                playerId: c.id,
                checkList: failures,
            })
        }
        this.save(p)
        room.change_vote = p.votes.map((vote) => vote.id)
        return this.teams.commitRoom(c, room, 12, { playerId: c.id })
    }
    maintenance(now) {
        const ms = milliseconds(now),
            rows = this.db
                .prepare("SELECT team_id FROM team_v2_target_changes WHERE status='pending' AND expires_at_ms<=?")
                .all(ms)
        if (!rows.length) return []
        ensure(
            typeof this.teams.encodeNotice === 'function',
            'TeamV2 maintenance encoder is unavailable',
            ErrorCode.GameConfig,
        )
        return this.db
            .transaction(() => {
                const packets = [],
                    c = {
                        id: 0,
                        now,
                        tables: this.teams.tables,
                        pushTo: (recipient, name, value) =>
                            packets.push(this.teams.encodeNotice(name, value, recipient)),
                    }
                for (const row of rows) {
                    const room = this.teams.getRoom(row.team_id)
                    ensure(room, 'Pending TeamV2 proposal room is unavailable', ErrorCode.GameConfig)
                    this.reconcile(c, room)
                }
                return packets
            })
            .immediate()
    }
}
