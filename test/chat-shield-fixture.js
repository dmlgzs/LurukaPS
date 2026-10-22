import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

export function chatShieldFixture(name, file = ':memory:') {
    const config = configuration(),
        protocol = new Protocol(config.base),
        tables = new Tables(config.tables),
        store = new Store(file)
    let now = 1800000000,
        sequence = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (session, name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: sequence++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    const sessions = ['a', 'b', 'c'].map((s) => {
        const session = {}
        call(session, 'EnterGame', { open_id: 'shield-' + name + '-' + s })
        return session
    })
    const [a, b, c] = sessions
    const state = (session) => store.load(session.id).state
    const change = (session, peer, op) => call(session, 'ChatShieldOp', { tar_id: peer.id ?? peer, op })
    const reply = (packets, id = 9947) =>
        protocol.decode(protocol.byId.get(id).rsp, packets.find((p) => p.id === id).payload)
    const send = (from, to, text, channel = 0) =>
        call(from, 'AddChat', {
            target: { chat_type: channel, tid: String(to.id ?? to) },
            msg: Buffer.from(text).toString('base64'),
            type: 0,
        })
    return {
        config,
        protocol,
        tables,
        store,
        game,
        sessions,
        a,
        b,
        c,
        call,
        state,
        change,
        reply,
        send,
        advance: (n) => {
            now += n
        },
        now: () => now,
    }
}
