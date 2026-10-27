import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petData } from '../src/pets.js'

const text = (value) => Buffer.from(String(value)).toString('base64')
export const modelCommand = (command, args) => ({ command: text(command), args: args.map(text) })
export function petModelFixture(name = 'pet-model', file = ':memory:') {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(file),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 })
    let seq = 1
    const call = (name, request = {}, current = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(current, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    const entryPackets = call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const owned = (configId) => {
        let pet = state().pets.find((row) => row.config_id === configId)
        if (!pet) {
            call('GMCommand', modelCommand('give', [5, configId, 1]))
            pet = state().pets.find((row) => row.config_id === configId)
        }
        return pet
    }
    const legacyBad = ({ defer = false } = {}) => {
        store.transact(
            session.id,
            0,
            (saved) => {
                // Controlled old persisted instance, intentionally bypasses the
                // new-instance producer. Do not grant or deploy it as a new pet.
                let pet = saved.pets.find((row) => row.guid === '500638')
                if (!pet) saved.pets.push((pet = petData(tables, 500638, '500638', 2999, undefined, () => 0)))
                const hero = saved.player.heros_info.heros[0],
                    manager = saved.player.group_mgrs.find((row) => row.type === 1)
                hero.pet_id = pet.guid
                pet.hero_id = hero.guid
                for (const group of manager.groups.filter((row) => [1, 2].includes(row.id))) {
                    group.heros[0] = { hero_id: hero.guid, pet_id: pet.guid }
                    group.control = hero.guid
                }
                manager.cur_group = 1
            },
            { defer },
        )
        return state().pets.find((row) => row.guid === '500638')
    }
    return { tables, protocol, store, session, game, call, state, owned, legacyBad, entryPackets, name }
}
