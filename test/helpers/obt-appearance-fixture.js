import assert from 'node:assert/strict'
import { configuration } from '../../src/config.js'
import { Tables } from '../../src/player.js'
import { Protocol } from '../../src/protocol.js'
import { Store } from '../../src/store.js'
import { Game } from '../../src/game.js'
import { ObtAppearanceConsumer } from './obt-appearance-consumer.js'

const config = configuration()
export const tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const now = 1800000000
export function fixture(name, { starterProfile = 'normal' } = {}) {
    const store = new Store(':memory:'),
        session = {},
        client = new ObtAppearanceConsumer(tables, protocol)
    const game = new Game(protocol, store, tables, { clock: () => now, starterProfile })
    let seq = 1
    const call = (name, data = {}, consumer = client, target = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        const packets = game.dispatch(target, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        })
        if (consumer) consumer.consumePackets(packets)
        return packets
    }
    const initial = call('EnterGame', { open_id: `appearance-current-${name}` })
    const login = () => {
        const next = new ObtAppearanceConsumer(tables, protocol)
        call('EnterGame', { open_id: `appearance-current-${name}`, reconnect: true }, next, {})
        return next
    }
    return {
        store,
        session,
        client,
        initial,
        call,
        login,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
    }
}
const activeGroup = (state) => {
    const manager = state.player.group_mgrs.find((manager) => manager.type === 1)
    return manager.groups.find((group) => group.id === manager.cur_group)
}
export function party(f, ids) {
    const state = f.state(),
        group = activeGroup(state)
    const heroes = ids.map((id) => state.player.heros_info.heros.find((hero) => hero.conf_id === id))
    assert(heroes.every(Boolean))
    const packets = f.call('QuickChangeGroupInfo', {
        type: 1,
        id: group.id,
        infos: heroes.map((hero) => ({ hero_guid: hero.guid, pet_guid: '0' })),
    })
    return { heroes, packets }
}
