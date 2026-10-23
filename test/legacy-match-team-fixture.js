import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'

export const teamConfig = configuration(),
    teamTables = new Tables(teamConfig.tables)
export const teamMaterial = teamTables.get('dungeon_material').find((row) => row.unlock === '2004#1')
assert(teamMaterial)
export function teamFixture({ database = ':memory:', count = 5, account = 'legacy-invites' } = {}) {
    const store = new Store(database),
        protocol = new Protocol(teamConfig.base)
    const time = { now: 1800000000 },
        online = new Set(),
        sessions = Array.from({ length: count }, () => ({}))
    const game = new Game(protocol, store, teamTables, { clock: () => time.now })
    game.legacyMatchTeams.isOnline = (id) => online.has(id)
    let sequence = 1
    const call = (index, name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name),
            session = sessions[index - 1]
        const packets = game.dispatch(session, {
            id: entry.id,
            seq: sequence++,
            payload: protocol.encode(entry.req, value),
        })
        if (session.entered) online.add(session.id)
        return packets
    }
    for (let index = 1; index <= count; index++) call(index, 'EnterGame', { open_id: account + '-' + index })
    const id = (index) => sessions[index - 1].id
    return {
        store,
        protocol,
        game,
        time,
        online,
        sessions,
        call,
        id,
        teams: game.legacyMatchTeams,
        decode: (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        state: (index) => store.load(id(index)).state,
        edit: (index, fn) => store.transact(id(index), 0, fn),
        room: (index = 1) => game.legacyMatchTeams.roomFor(id(index)),
        create: (index = 1, dungeon = teamMaterial.dungeonId) =>
            call(index, 'CreateMatchTeam', { dungeon_id: dungeon, scene_type: 12 }),
        invite: (from, to, position = 1) =>
            call(from, 'InviteJoin', {
                pid: id(to),
                position,
                dungeon_id: game.legacyMatchTeams.roomFor(id(from)).target.dungeon_id,
            }),
        advance: (seconds) => {
            time.now += seconds
        },
        relog: (index) => {
            sessions[index - 1] = {}
            return call(index, 'EnterGame', { open_id: account + '-' + index })
        },
    }
}
