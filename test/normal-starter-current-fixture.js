import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

export function createNormalStarterFixture(name, { starterProfile = 'normal', legacy = false, traceDirectory } = {}) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    const trace = []
    const directory = traceDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-starter-trace-'))
    let nowMs = 1800000000000,
        sequence = 1,
        session = {},
        baseline
    if (legacy) {
        // Explicit pre-existing unversioned save fixture: no ownership is cut
        // from a sandbox login and no new normal account uses this branch.
        const saved = store.login(name, (id, openId) => {
            const state = seedPlayer(tables, id, openId, { mode: 'sandbox' })
            delete state.starterProfile
            state.world.unlockAllMaps = true
            return state
        })
        baseline = saved.state
    }
    const gameOptions = {
        starterProfile,
        clock: () => Math.floor(nowMs / 1000),
        arenaClockMs: () => nowMs,
        rng: () => 0,
    }
    let game = new Game(protocol, store, tables, gameOptions)
    const frame = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        if (!entry) throw Error('Current protocol unavailable: ' + name)
        return {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        }
    }
    const state = () => store.load(session.id).state
    const summary = () => {
        const saved = state(),
            groupManager = saved.player.group_mgrs.find((row) => row.type === 1)
        return {
            marker: saved.starterProfile,
            map: saved.world.map_id,
            sex: saved.player.basic_info.sex,
            heroes: saved.player.heros_info.heros.map(({ guid, conf_id, type }) => ({ guid, conf_id, type })),
            pets: saved.pets.map(({ guid, config_id }) => ({ guid, config_id })),
            points: saved.world.points,
            group: groupManager?.cur_group,
            control: groupManager?.groups.find((row) => row.id === groupManager.cur_group)?.control,
            tasks: (saved.tasks ?? []).map(({ task_id, nodes }) => ({
                task_id,
                nodes: nodes.map(({ node_id }) => node_id),
            })),
        }
    }
    const dispatch = (request, connection = session) => {
        const entry = protocol.byId.get(request.id)
        try {
            const packets = game.dispatch(connection, request)
            for (const packet of packets) {
                const descriptor = protocol.byId.get(packet.id)
                if (!descriptor?.rsp) throw Error('Outgoing current protocol missing: ' + packet.id)
                protocol.decode(descriptor.rsp, packet.payload)
            }
            trace.push({ id: request.id, name: entry.name, packets: packets.map(({ id }) => id), summary: summary() })
            return packets
        } catch (error) {
            trace.push({ id: request.id, name: entry.name, error: error.message, code: error.code })
            throw error
        }
    }
    const call = (name, data = {}, connection = session) => dispatch(frame(name, data), connection)
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    const currentGroup = () => {
        const manager = state().player.group_mgrs.find((row) => row.type === 1)
        return manager.groups.find((row) => row.id === manager.cur_group)
    }
    return {
        tables,
        protocol,
        store,
        get game() {
            return game
        },
        frame,
        dispatch,
        call,
        login,
        coldLogin: () => {
            // New server/catalogue/protocol objects, same actual persisted
            // memory account; this never seeds or edits the existing save.
            game = new Game(new Protocol(config.base), store, new Tables(config.tables), gameOptions)
            session = {}
            return call('EnterGame', { open_id: name })
        },
        state,
        currentGroup,
        summary,
        baseline,
        session: () => session,
        advanceMs: (amount) => {
            if (!Number.isSafeInteger(amount) || amount < 0) throw Error('Invalid test clock advance')
            nowMs += amount
        },
        nowMs: () => nowMs,
        close: () => {
            fs.mkdirSync(directory, { recursive: true })
            fs.writeFileSync(
                path.join(directory, name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'),
                JSON.stringify({ trace }, null, 2) + '\n',
            )
            store.close()
        },
    }
}
