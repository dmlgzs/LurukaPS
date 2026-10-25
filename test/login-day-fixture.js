import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const cfg = configuration()
export const loginTables = new Tables(cfg.tables)
export function loginDayFixture(openId, file = ':memory:', start = 1800000000) {
    const tables = loginTables,
        protocol = new Protocol(cfg.base),
        store = new Store(file)
    let now = start,
        sequence = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        if (!entry) throw Error('Missing test protocol:' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    call('Login', { open_id: openId })
    const id = session.id
    const enter = (name = 'EnterGame', options = {}) => {
        session = {}
        return call(name, { open_id: openId, ...options })
    }
    return {
        tables,
        protocol,
        store,
        game,
        id,
        call,
        enter,
        state: () => store.load(id).state,
        edit: (fn) => store.transact(id, 0, fn),
        time: (value) => (now = value),
        now: () => now,
        day: () => Math.floor((now + 4 * 3600) / 86400),
        session: () => session,
        close: () => store.close(),
    }
}
