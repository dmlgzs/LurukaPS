import { ErrorCode } from './error-codes.js'
import { ensure, group } from './handlers/common.js'
import { materialDungeonUnlocked } from './material-dungeons.js'
import { requireWeeklySystem, weeklyDungeonUnlocked } from './weekly-dungeons.js'
import { getEntrustCatalog } from './entrust.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const playerId = (n) => uint(n) && n > 0
// MultiTeamStore::.ctor06018645 gives system types1/2 three positions.
// InviteData.team_id is cast to Int32 by SyncTeamInvite06025dcf.
const MAX_MEMBERS = 3
const MAX_ROOM_ID = 0x7fffffff

export function legacyMatchTarget(c, r) {
    ensure(playerId(r.dungeon_id), 'Invalid team dungeon identity', ErrorCode.ReqParamsError)
    ensure(uint(r.scene_type ?? 0) && uint(r.dungeon_site ?? 0), 'Invalid team scene', ErrorCode.ReqParamsError)
    ensure(
        r.scene_type === 12 && !r.dungeon_site && !r.random && !r.cancel,
        'This legacy team target family is not implemented',
        ErrorCode.FunctionClosed,
    )
    const material = c.tables.get('dungeon_material').filter((row) => row.dungeonId === r.dungeon_id)
    const weekly = c.tables.get('dungeon_weekly').filter((row) => row.dungeonId === r.dungeon_id)
    ensure(material.length + weekly.length > 0, 'Team dungeon configuration unavailable', ErrorCode.DungeonConfNotExist)
    ensure(material.length + weekly.length === 1, 'Ambiguous team dungeon configuration', ErrorCode.GameConfig)
    const definition = weekly[0] ?? material[0],
        kind = weekly.length ? 'weekly' : 'material'
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
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS legacy_match_rooms (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS legacy_match_members (player_id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS legacy_match_members_room ON legacy_match_members(room_id);
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
                ['material', 'weekly'].includes(room.target.kind) &&
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
        const definition = this.tables.find(
            room.target.kind === 'weekly' ? 'dungeon_weekly' : 'dungeon_material',
            room.target.config_id,
        )
        ensure(
            definition?.dungeonId === room.target.dungeon_id,
            'Saved team target no longer matches its configuration',
            ErrorCode.GameConfig,
        )
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
                // Online presence is a transport fact. Do not fabricate every
                // persisted member as online; the present caller is known here.
                online_players: members.filter((member) => member.pid === ownId).map((member) => member.pid),
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
}

export function registerLegacyMatchTeams(on, store, tables) {
    const teams = new LegacyMatchTeams(store, tables)
    on('CreateMatchTeam', (c, r) => teams.create(c, r))
    on('LeaveMatchTeam', (c, r) => teams.leave(c, r))
    return teams
}
