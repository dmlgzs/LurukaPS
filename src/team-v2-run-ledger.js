import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { compileSharedTeamTarget } from './team-v2-run-target.js'
import { currentMapMember } from './current-map-member.js'
import { currentMapMemberAttribute } from './current-map-attributes.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const key = (value) => typeof value === 'string' && value.length > 0
const digest = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Internal shared-run authority, not a public Start backend. Preparation,
// entry packets, loading/controller, shared HP and personal settlement still
// need their lifecycle adapter before TeamV2Service.backend may be connected.
export class TeamV2RunLedger {
    constructor(teams) {
        this.teams = teams
        this.store = teams.store
        this.db = teams.store.db
        this.db.exec(`CREATE TABLE IF NOT EXISTS team_v2_runs (
    id TEXT PRIMARY KEY, team_id INTEGER NOT NULL, generation INTEGER NOT NULL,
    revision INTEGER NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL,
    UNIQUE(team_id,generation)
  ); CREATE INDEX IF NOT EXISTS team_v2_runs_team ON team_v2_runs(team_id);`)
        this.routingVersion = this.db.prepare(`SELECT r.id,r.revision,
          v.id AS run_id,v.revision AS run_revision,v.phase
          FROM team_v2_members m JOIN team_v2_rooms r ON r.id=m.team_id
          LEFT JOIN team_v2_runs v ON v.id=json_extract(r.payload,'$.run_id')
          WHERE m.player_id=?`)
        this.routeDiagnostics = new Set()
    }
    read(id) {
        ensure(
            typeof id === 'string' && /^team-v2-run:[1-9]\d*$/.test(id),
            'Malformed shared run identity',
            ErrorCode.GameConfig,
        )
        const stored = this.db
            .prepare(
                'SELECT id,CAST(team_id AS TEXT) AS team_id,generation,revision,phase,payload FROM team_v2_runs WHERE id=?',
            )
            .get(id)
        if (!stored) return null
        let run
        try {
            run = JSON.parse(stored.payload)
        } catch {
            ensure(false, 'Corrupt shared run JSON', ErrorCode.GameConfig)
        }
        ensure(
            run?.schema_version === 1 &&
                run.id === id &&
                run.team_id === String(stored.team_id) &&
                run.generation === stored.generation &&
                run.revision === stored.revision &&
                run.phase === stored.phase &&
                positive(run.generation) &&
                positive(run.revision) &&
                ['admitting', 'loading', 'playing', 'complete', 'closed'].includes(run.phase) &&
                positive(run.captain) &&
                positive(run.map_id) &&
                Array.isArray(run.members) &&
                run.members.length >= 1 &&
                run.members.length <= 3,
            'Corrupt shared run header',
            ErrorCode.GameConfig,
        )
        ensure(
            run.members.every(
                (m, i) =>
                    positive(m.id) &&
                    positive(m.site) &&
                    positive(m.lease) &&
                    m.site <= 3 &&
                    (i === 0 || run.members[i - 1].site < m.site) &&
                    /^[0-9a-f]{64}$/.test(m.admission_connection_hash),
            ) &&
                new Set(run.members.map((m) => m.id)).size === run.members.length &&
                run.members.some((m) => m.id === run.captain),
            'Corrupt shared run roster',
            ErrorCode.GameConfig,
        )
        const compiled = compileSharedTeamTarget(this.teams.tables, { typ: run.typ, target: run.target })
        ensure(
            compiled.fingerprint === run.source_fingerprint && compiled.route.scene.id === run.map_id,
            'Shared run configuration changed',
            ErrorCode.GameConfig,
        )
        return run
    }
    requireCurrent(c) {
        const room = this.teams.roomFor(c.id)
        ensure(room?.run_id, 'No shared run for current team', ErrorCode.NotInMultiCampaign)
        const run = this.read(room.run_id)
        ensure(
            run &&
                run.team_id === room.id &&
                run.generation === room.run_generation &&
                room.revision >= run.team_revision &&
                room.typ === run.typ &&
                same(room.target, run.target) &&
                run.captain === room.captain &&
                same(
                    [...run.members].sort((a, b) => a.site - b.site).map((m) => [m.id, m.site, m.lease]),
                    [...room.members].sort((a, b) => a.site - b.site).map((m) => [m.id, m.site, m.lease]),
                ),
            'Shared run no longer matches its authoritative team',
            ErrorCode.TeamTargetChanged,
        )
        const member = run.members.find((m) => m.id === c.id),
            connection = this.teams.connectionKey(c.id)
        ensure(
            member &&
                key(c.combatSessionId) &&
                c.combatSessionId === connection &&
                member.admission_connection_hash === digest(connection),
            'Shared run connection admission changed',
            ErrorCode.TeamTargetChanged,
        )
        return { room, run, member }
    }
    admit(c, room, { states: preparedStates } = {}) {
        ensure(
            this.db.inTransaction && (preparedStates === undefined || preparedStates instanceof Map),
            'Shared admission requires an atomic multi-account transaction',
            ErrorCode.GameConfig,
        )
        const authority = this.teams.requireRoom(c, room.id, { captain: true })
        ensure(
            authority.revision === room.revision,
            'Shared team admission revision changed',
            ErrorCode.TeamWaitStateSync,
        )
        room = authority
        ensure(room.captain === c.id, 'Only captain can admit a shared run', ErrorCode.IsNotMatchTeamLeader)
        ensure(
            room.state === 3 && !room.run_id,
            'Shared run must start from admitted PRE_START',
            ErrorCode.TeamInBattle,
        )
        ensure(
            Array.isArray(room.ready) &&
                room.members.length >= 2 &&
                new Set(room.ready).size === room.members.length &&
                room.members.every((m) => room.ready.includes(m.id)),
            'Shared participants are not all ready',
            ErrorCode.TeamWaitStateSync,
        )
        ensure(
            key(c.combatSessionId) && c.combatSessionId === this.teams.connectionKey(c.id),
            'Shared admission caller connection changed',
            ErrorCode.TeamTargetChanged,
        )
        const compiled = compileSharedTeamTarget(c.tables, room),
            states = new Map(),
            members = []
        for (const member of [...room.members].sort((a, b) => a.site - b.site)) {
            ensure(this.teams.isOnline(member.id), 'Shared participant is offline', ErrorCode.PlayerNotOnline)
            const connection = this.teams.connectionKey(member.id)
            ensure(key(connection), 'Shared participant has no current connection', ErrorCode.PlayerNotOnline)
            const state =
                member.id === c.id ? c.state : (preparedStates?.get(member.id) ?? this.store.load(member.id).state)
            ensure(
                !state.entrust?.run &&
                    !state.multiCampaign &&
                    !state.storyCampaign &&
                    !state.cultTrial &&
                    !state.abyssRun,
                'Shared participant is already in a dungeon',
                ErrorCode.TeamInBattle,
            )
            this.teams.requireTarget(c, room, member.id, state)
            states.set(member.id, state)
            members.push({
                id: member.id,
                site: member.site,
                lease: member.lease,
                admission_connection_hash: digest(connection),
            })
        }
        const generation = (room.run_generation ?? 0) + 1
        ensure(positive(generation) && uint(c.now), 'Shared run generation/clock exhausted', ErrorCode.GameConfig)
        const id = 'team-v2-run:' + this.store.nextSequence('team-v2-run', 0xffffffff)
        const run = {
            schema_version: 1,
            id,
            team_id: room.id,
            team_revision: room.revision + 1,
            generation,
            revision: 1,
            phase: 'admitting',
            captain: room.captain,
            typ: room.typ,
            target: structuredClone(room.target),
            map_id: compiled.route.scene.id,
            source_fingerprint: compiled.fingerprint,
            members,
            created_at: c.now,
        }
        // This records an internal admission reference only. It does not set PLAY,
        // publish9510, move players or invent a ready/controller transition.
        const saved = this.teams.commitRoom(c, { ...room, run_id: id, run_generation: generation }, 0, { states })
        ensure(
            saved.revision === run.team_revision,
            'Shared admission room revision changed unexpectedly',
            ErrorCode.GameConfig,
        )
        this.db
            .prepare('INSERT INTO team_v2_runs(id,team_id,generation,revision,phase,payload) VALUES(?,?,?,?,?,?)')
            .run(id, room.id, generation, run.revision, run.phase, JSON.stringify(run))
        return { run, room: saved, states, compiled }
    }
    #save(run, next) {
        ensure(this.db.inTransaction, 'Shared run update requires an atomic transaction', ErrorCode.GameConfig)
        ensure(run.revision < 0xffffffff, 'Shared run revision exhausted', ErrorCode.GameConfig)
        const saved = { ...next, revision: run.revision + 1 }
        const result = this.db
            .prepare('UPDATE team_v2_runs SET revision=?,phase=?,payload=? WHERE id=? AND revision=?')
            .run(saved.revision, saved.phase, JSON.stringify(saved), run.id, run.revision)
        ensure(result.changes === 1, 'Shared run revision changed', ErrorCode.TeamWaitStateSync)
        return saved
    }
    // Called only after the real entry adapter has prepared every participant's
    // current material/weekly scene in this same Store transaction. It does not
    // create a scene, emit PLAY, share NPCs or mark a participant loaded.
    bindScenes(c) {
        const { room, run } = this.requireCurrent(c)
        ensure(c.id === run.captain, 'Only the captain may bind a shared entry', ErrorCode.IsNotMatchTeamLeader)
        ensure(
            this.db.inTransaction && typeof c.editPlayer === 'function',
            'Shared scene binding requires editable participant drafts',
            ErrorCode.GameConfig,
        )
        ensure(
            room.state === 3 && run.phase === 'admitting',
            'Shared scene binding is not in its admission phase',
            ErrorCode.TeamInBattle,
        )
        const { definition } = compileSharedTeamTarget(c.tables, room),
            states = new Map()
        for (const member of run.members) {
            const state = member.id === c.id ? c.state : c.editPlayer(member.id),
                entry = state.entrust?.run,
                connection = this.teams.connectionKey(member.id)
            ensure(
                this.teams.isOnline(member.id) &&
                    key(connection) &&
                    digest(connection) === member.admission_connection_hash,
                'Shared entry participant connection changed',
                ErrorCode.TeamTargetChanged,
            )
            ensure(
                state.world.map_id === run.map_id &&
                    entry?.map_id === run.map_id &&
                    entry.entrust_id === definition.configId &&
                    entry.dungeon_id === definition.dungeonId &&
                    entry.kind === definition.kind &&
                    entry.status === 2 &&
                    !entry.battle_complete &&
                    !state.sharedTeamRun &&
                    !state.multiCampaign &&
                    !state.storyCampaign &&
                    !state.cultTrial &&
                    !state.abyssRun,
                'Shared participant entry is unavailable or changed',
                ErrorCode.TeamTargetChanged,
            )
            ensure(positive(entry.instance_id), 'Shared entry instance identity is malformed', ErrorCode.GameConfig)
            states.set(member.id, state)
        }
        // Only identity is shared here. Do not copy another player's combat,
        // reward receipts, assets, entry return position or completion flags.
        for (const member of run.members) {
            const state = states.get(member.id)
            state.sharedTeamRun = {
                id: run.id,
                generation: run.generation,
                lease: member.lease,
                entry_instance_id: state.entrust.run.instance_id,
            }
        }
        return { run: this.#save(run, { ...run, phase: 'loading' }), room, states }
    }
    close(c) {
        const { run } = this.requireCurrent(c)
        ensure(c.id === run.captain, 'Only the captain may close a shared run', ErrorCode.IsNotMatchTeamLeader)
        if (run.phase === 'closed') return run
        // This revokes delivery authority only. The entry/exit adapter remains
        // responsible for return worlds, member departure and personal claims.
        return this.#save(run, { ...run, phase: 'closed' })
    }
    diagnoseRoute(id, ref, error) {
        const identity = `${id}:${ref?.id}:${error.code}:${error.message}`
        if (this.routeDiagnostics.has(identity)) return
        if (this.routeDiagnostics.size >= 64) this.routeDiagnostics.clear()
        this.routeDiagnostics.add(identity)
        console.warn(
            '[team-v2-run]',
            JSON.stringify({
                event: 'scene-route-rejected',
                player_id: id,
                run_id: ref?.id,
                error_code: error.code,
                reason: error.message,
            }),
        )
    }
    routeToken(id) {
        try {
            const row = this.routingVersion.get(id)
            if (!row?.run_id) return null
            const connection = this.teams.connectionKey(id)
            return JSON.stringify([
                row.id,
                row.revision,
                row.run_id,
                row.run_revision,
                row.phase,
                this.teams.isOnline(id),
                key(connection) ? digest(connection) : null,
            ])
        } catch (error) {
            this.diagnoseRoute(id, null, error)
            return 'invalid-shared-route'
        }
    }
    sceneRoute(state, id) {
        const ref = state.sharedTeamRun
        if (!ref) return null
        try {
            const { room, run, member } = this.requireCurrent({ id, combatSessionId: this.teams.connectionKey(id) })
            if (run.phase === 'closed' || room.state !== 4) return null
            const { definition } = compileSharedTeamTarget(this.teams.tables, room)
            this.#requireSceneBinding(state, run, member, definition)
            ensure(this.teams.isOnline(id), 'Shared participant is offline', ErrorCode.PlayerNotOnline)
            return Object.freeze({ map: run.map_id, scope: `team-v2:${run.id}:${run.generation}:${run.map_id}` })
        } catch (error) {
            this.diagnoseRoute(id, ref, error)
            return null
        }
    }
    #requireSceneBinding(state, run, member, definition) {
        const ref = state.sharedTeamRun,
            entry = state.entrust?.run
        ensure(
            ref &&
                typeof ref === 'object' &&
                !Array.isArray(ref) &&
                typeof ref.id === 'string' &&
                /^team-v2-run:[1-9]\d*$/.test(ref.id) &&
                positive(ref.generation) &&
                positive(ref.lease) &&
                positive(ref.entry_instance_id),
            'Saved shared scene reference is malformed',
            ErrorCode.GameConfig,
        )
        ensure(
            ref.id === run.id &&
                ref.generation === run.generation &&
                ref.lease === member.lease &&
                ref.entry_instance_id === entry?.instance_id &&
                ['loading', 'playing', 'complete'].includes(run.phase) &&
                state.world.map_id === run.map_id &&
                entry?.map_id === run.map_id &&
                entry.entrust_id === definition.configId &&
                entry.dungeon_id === definition.dungeonId &&
                entry.kind === definition.kind &&
                [2, 3].includes(entry.status),
            'Shared scene membership, entry or generation changed',
            ErrorCode.TeamTargetChanged,
        )
    }
    baseInfo(c, { states } = {}) {
        const { room, run } = this.requireCurrent(c)
        ensure(
            states === undefined || states instanceof Map,
            'Shared snapshot draft map is malformed',
            ErrorCode.GameConfig,
        )
        ensure(
            room.state === 4 && ['loading', 'playing', 'complete'].includes(run.phase),
            'Shared dungeon snapshot is not active',
            ErrorCode.TeamWaitStateSync,
        )
        const { definition } = compileSharedTeamTarget(this.teams.tables, room),
            players = [],
            attrs = []
        for (const member of run.members) {
            const project = (state) => {
                this.#requireSceneBinding(state, run, member, definition)
                return {
                    player: currentMapMember(state, member.id),
                    attr: currentMapMemberAttribute(this.teams.tables, state, member.id),
                }
            }
            const data =
                member.id === c.id
                    ? project(c.state)
                    : states?.has(member.id)
                      ? project(states.get(member.id))
                      : this.store.read(member.id, project)
            players.push(data.player)
            attrs.push(data.attr)
        }
        // MCPS_READY preserves the existing campaign participation status.
        // It does not mark TeamV2Member.play or the future loading barrier done.
        return {
            dungeon_id: definition.dungeonId,
            dungeon_scene_id: run.map_id,
            player_list: players,
            player_attr_list: attrs,
            team_option_list: run.members.map((member) => ({ player_id: member.id, stay: true })),
            player_status_list: run.members.map((member) => ({ player_id: member.id, status: 1 })),
        }
    }
}
