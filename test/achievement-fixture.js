import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

export function achievementFixture(name, file = ':memory:') {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base)
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    const session = {}
    let sequence = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    const entryPackets = call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const completedTask = (id) =>
        store.transact(session.id, 0, (s) => {
            s.taskRecords ??= []
            if (!s.taskRecords.some((r) => r.task_id === id))
                s.taskRecords.push({ task_id: id, count: 1, time: 1799999900 })
        })
    const reply = (packets, id) => protocol.decode('Rewards', packets.find((p) => p.id === id).payload)
    return { cfg, tables, protocol, store, game, session, call, entryPackets, state, completedTask, reply }
}
