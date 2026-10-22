import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
export function setup(file = ':memory:', unlock = true) {
    const cfg = configuration(),
        protocol = new Protocol(cfg.base),
        tables = new Tables(cfg.tables),
        store = new Store(file)
    let seq = 1
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    call('EnterGame', { open_id: 'social-wheel' })
    if (unlock) store.transact(session.id, 0, (s) => (s.taskRecords ??= []).push({ task_id: 106010, count: 1 }))
    const login = call('EnterGame', { open_id: 'social-wheel' }, {})
    const decode = (p) => protocol.decode(protocol.byId.get(p.id).rsp, p.payload)
    return {
        cfg,
        protocol,
        tables,
        store,
        game,
        session,
        call,
        login,
        decode,
        sync: (out) => decode(out.find((p) => p.id === 6580)),
        state: () => store.load(session.id).state,
        close: () => store.close(),
    }
}
