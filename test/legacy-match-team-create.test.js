import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables)
const target = tables.get('dungeon_material').find((row) => row.unlock === '2004#1')
assert(target)
const request = { dungeon_id: target.dungeonId, scene_type: 12 }
function fixture(filename = ':memory:') {
    const store = new Store(filename),
        protocol = new Protocol(config.base)
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, value = {}, client = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(client, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, value) })
    }
    call('EnterGame', { open_id: 'legacy-room-create' })
    return {
        store,
        protocol,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        room: () => game.legacyMatchTeams.roomFor(session.id),
        decode: (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
    }
}
const errorCode = (code) => (error) => error.code === code

test('9522 creates a canonical room and membership, emits9520 with configured target and owned formation, and sends no invented ACK', () => {
    const f = fixture()
    try {
        const before = f.state(),
            packets = f.call('CreateMatchTeam', request),
            room = f.room()
        assert.equal(
            packets.some((packet) => packet.id === 9522),
            false,
        )
        const sync = f.decode(packets.find((packet) => packet.id === 9520))
        assert.equal(room.captain, f.session.id)
        assert.equal(room.target.config_id, target.id)
        assert.equal(room.target.kind, 'material')
        assert.equal(sync.reason, 0)
        assert.equal(sync.team.team_id, room.id)
        assert.equal(sync.team.dungeon_id, target.dungeonId)
        assert.equal(sync.team.scene_type, 12)
        assert.equal(sync.team.members[0].name, Buffer.from(before.player.basic_info.name, 'base64').toString('utf8'))
        assert.deepEqual(
            sync.team.members.map((member) => member.pid),
            [f.session.id],
        )
        const formation = before.player.group_mgrs.find((row) => row.type === 1)
        const control = formation.groups.find((row) => row.id === formation.cur_group).control
        assert.equal(
            sync.team.members[0].control_hero,
            before.player.heros_info.heros.find((row) => row.guid === control).conf_id,
        )
        assert.deepEqual(sync.team.ready_players, [])
        assert.equal(f.state().world.map_id, before.world.map_id)
        assert.deepEqual(f.state().inventory, before.inventory)
        assert.equal(f.state().entrust?.run, undefined)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_members').get().n, 1)
        assert.throws(() => f.call('CreateMatchTeam', request), errorCode(ErrorCode.IsInMatchTeam))
        assert.equal(f.room().id, room.id)
        assert.equal(
            f.store.db.prepare('SELECT value FROM sequences WHERE name=?').get('legacy-match-team').value,
            room.id,
        )
    } finally {
        f.store.close()
    }
})

test('9520 transmits pet configuration IDs rather than GUIDs and revalidates saved target links', () => {
    const f = fixture()
    try {
        let petId
        f.store.transact(f.session.id, 0, (state) => {
            const manager = state.player.group_mgrs.find((row) => row.type === 1)
            const formation = manager.groups.find((row) => row.id === manager.cur_group)
            const pet = state.pets.find((row) => row.config_id > 0)
            assert(pet)
            petId = pet.config_id
            formation.heros[0].pet_id = pet.guid
        })
        const packets = f.call('CreateMatchTeam', request)
        const sync = f.decode(packets.find((packet) => packet.id === 9520))
        assert.equal(sync.team.members[0].heros[0].pet_id, petId)
        const room = f.room()
        room.target.dungeon_id = 0xffffffff
        f.store.db.prepare('UPDATE legacy_match_rooms SET payload=? WHERE id=?').run(JSON.stringify(room), room.id)
        assert.throws(() => f.room(), errorCode(ErrorCode.GameConfig))
    } finally {
        f.store.close()
    }
})

test('9522 rejects missing targets, locked configurations, unsupported scene families and active dungeons without creating rooms', () => {
    const f = fixture()
    try {
        for (const [value, code] of [
            [{ ...request, dungeon_id: 0 }, ErrorCode.ReqParamsError],
            [{ ...request, dungeon_id: 0xffffffff }, ErrorCode.DungeonConfNotExist],
            [{ ...request, scene_type: 22, dungeon_site: 1 }, ErrorCode.FunctionClosed],
            [{ ...request, scene_type: 25 }, ErrorCode.FunctionClosed],
            [{ ...request, dungeon_site: 1 }, ErrorCode.FunctionClosed],
            [{ ...request, random: true }, ErrorCode.FunctionClosed],
            [{ ...request, cancel: true }, ErrorCode.FunctionClosed],
        ])
            assert.throws(() => f.call('CreateMatchTeam', value), errorCode(code))
        const locked = tables.get('dungeon_material').find((row) => row.unlock.startsWith('2004#15'))
        assert(locked)
        assert.throws(
            () => f.call('CreateMatchTeam', { ...request, dungeon_id: locked.dungeonId }),
            errorCode(ErrorCode.EntrustUnlock),
        )
        for (const key of ['storyCampaign', 'multiCampaign', 'cultTrial', 'abyssRun']) {
            f.store.transact(f.session.id, 0, (state) => {
                state[key] = { audit_fixture: true }
            })
            assert.throws(() => f.call('CreateMatchTeam', request), errorCode(ErrorCode.TeamInBattle))
            f.store.transact(f.session.id, 0, (state) => {
                delete state[key]
            })
        }
        assert.equal(f.room(), null)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_rooms').get().n, 0)
        assert.equal(f.store.db.prepare('SELECT value FROM sequences WHERE name=?').get('legacy-match-team'), undefined)
    } finally {
        f.store.close()
    }
})

test('9520 encoding failure rolls back room, membership and allocated identity, then a real retry succeeds once', () => {
    const f = fixture(),
        original = f.protocol.encode.bind(f.protocol)
    try {
        const before = structuredClone(f.state())
        f.protocol.encode = (type, data) => {
            if (type === f.protocol.byId.get(9520).rsp) throw Error('isolated team encoding failure')
            return original(type, data)
        }
        assert.throws(() => f.call('CreateMatchTeam', request), /isolated team encoding failure/)
        assert.equal(f.room(), null)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM legacy_match_rooms').get().n, 0)
        assert.equal(f.store.db.prepare('SELECT value FROM sequences WHERE name=?').get('legacy-match-team'), undefined)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = original
        f.call('CreateMatchTeam', request)
        assert.equal(f.room().id, 1)
    } finally {
        f.protocol.encode = original
        f.store.close()
    }
})

test('room IDs respect the client Int32 cast, and corrupt room or membership data is rejected without allocation', () => {
    const f = fixture()
    try {
        f.store.db.prepare('INSERT INTO sequences(name,value) VALUES(?,?)').run('legacy-match-team', 0x7ffffffe)
        f.call('CreateMatchTeam', request)
        const room = f.room()
        assert.equal(room.id, 0x7fffffff)
        f.store.db.prepare('UPDATE legacy_match_rooms SET payload=? WHERE id=?').run('{', room.id)
        assert.throws(() => f.room(), errorCode(ErrorCode.GameConfig))
        f.store.db.prepare('UPDATE legacy_match_rooms SET payload=? WHERE id=?').run(JSON.stringify(room), room.id)
        f.store.db.prepare('INSERT INTO legacy_match_members(player_id,room_id) VALUES(?,?)').run(999, room.id)
        assert.throws(() => f.room(), errorCode(ErrorCode.GameConfig))
        f.store.db.prepare('DELETE FROM legacy_match_members WHERE player_id=?').run(999)
        const second = {}
        f.call('EnterGame', { open_id: 'legacy-room-exhaustion' }, second)
        assert.throws(() => f.call('CreateMatchTeam', request, second), errorCode(ErrorCode.GameConfig))
        assert.equal(f.game.legacyMatchTeams.roomFor(second.id), null)
    } finally {
        f.store.close()
    }
})

test('room authority survives a real database close/reopen and login emits reason1 without creating another room', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-legacy-room-')),
        database = path.join(directory, 'state.db')
    const stores = []
    try {
        const first = fixture(database)
        stores.push(first.store)
        first.call('CreateMatchTeam', request)
        const room = first.room()
        first.store.close()
        const next = fixture(database)
        stores.push(next.store)
        assert.deepEqual(next.room(), room)
        const login = {}
        const packets = next.call('EnterGame', { open_id: 'legacy-room-create' }, login)
        const sync = next.decode(packets.find((packet) => packet.id === 9520))
        assert.equal(sync.reason, 1)
        assert.equal(sync.team.team_id, room.id)
        assert.equal(next.store.db.prepare('SELECT count(*) AS n FROM legacy_match_rooms').get().n, 1)
    } finally {
        for (const store of stores) store.close()
        const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory))
        assert(
            relative &&
                !relative.startsWith('..') &&
                !path.isAbsolute(relative) &&
                path.basename(directory).startsWith('luruka-legacy-room-'),
        )
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
