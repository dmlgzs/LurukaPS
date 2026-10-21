import { configuration } from '../../src/config.js'
import { Protocol } from '../../src/protocol.js'
import { Tables } from '../../src/player.js'
import { Store } from '../../src/store.js'
import { Game } from '../../src/game.js'
import { createCustomOrnaments } from '../../src/ornaments.js'

export function ornamentFixture(name) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: name })
    const configs = tables.get('accessory_customed')
    const selected = [...new Map(configs.map((row) => [tables.find('accessory', row.accessoryId).type, row])).values()]
    store.transact(session.id, 0, (s) => {
        s.ornaments = []
        for (const row of [...selected, selected[0]]) createCustomOrnaments(tables, s, row.id, 1, () => 0)
    })
    return {
        config,
        tables,
        protocol,
        store,
        game,
        session,
        call,
        state,
        reload: () => call('EnterGame', { open_id: name }, {}),
    }
}
