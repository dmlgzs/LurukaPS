import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
export const cfg = configuration(),
    tables = new Tables(cfg.tables)
export function fixture(file = ':memory:', source = tables) {
    const p = new Protocol(cfg.base),
        store = new Store(file, { flushIntervalMs: 60000 })
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(p, store, source, { clock: () => now, rng: (a, b) => (b === undefined ? 0 : a) })
    const call = (name, data = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, data) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    const reload = () => {
        session = {}
        return call('EnterGame', { open_id: 'ecology-progress' })
    }
    reload()
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = source.get('task').map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        s.world.map_id = 996
    })
    return {
        p,
        store,
        game,
        call,
        reload,
        get session() {
            return session
        },
        get now() {
            return now
        },
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        setTime: (n) => {
            now = n
        },
        reset: () => call('WorldEcologyReset'),
        step: (id, step) => call('WorldEcologyStep', { id, step }),
        close: () => store.close(),
    }
}
