import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

export function petCosmeticsFixture(name, file = ':memory:') {
    const config = configuration(),
        protocol = new Protocol(config.base),
        tables = new Tables(config.tables)
    const store = new Store(file),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request = {}, target = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    const login = (target = session) => call('EnterGame', { open_id: 'pet-cosmetics-' + name }, target)
    const packets = login(),
        state = () => store.load(session.id).state
    const decode = (packets, id) => protocol.decode(protocol.byId.get(id).rsp, packets.find((p) => p.id === id).payload)
    return { config, protocol, tables, store, game, session, call, login, packets, state, decode }
}
