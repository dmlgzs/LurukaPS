import { configuration } from '../src/config.js'
import { Tables, heroData } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petData } from '../src/pets.js'
const cfg = configuration()
export function abyssFixture(name = 'abyss-challenge', file = ':memory:', resume = false) {
    const tables = new Tables(cfg.tables),
        p = new Protocol(cfg.base),
        store = new Store(file),
        session = {},
        time = { now: 1800000000 },
        game = new Game(p, store, tables, { clock: () => time.now })
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get(name.startsWith('CSProto') ? name : 'CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: e.req ? p.encode(e.req, r) : Buffer.alloc(0) })
    }
    const decode = (packets, name) => {
        const e = p.byName.get(name)
        const matches = packets.filter((x) => x.id === e.id)
        // A map-element priming delta is separate from actual scene entry.
        // Existing scene assertions explicitly decode the cmd49/256 payload.
        const packet =
            name === 'CSProtoWorldMapSync'
                ? (matches.find((x) => [49, 256].includes(p.decode(e.rsp, x.payload).cmd)) ?? matches[0])
                : matches[0]
        return p.decode(e.rsp, packet.payload)
    }
    const login = call('EnterGame', { open_id: name })
    if (!resume)
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 20005)))
            if (!s.player.heros_info.heros.some((x) => x.conf_id === 101010))
                s.player.heros_info.heros.push(heroData(101010, session.id))
            const guid = ((2n << 56n) | (1n << 32n) | BigInt(session.id)).toString()
            s.pets.push(petData(tables, 500306, guid, 101))
        })
    const state = () => store.load(session.id).state
    const request = (mode = 1, id = 10001) => {
        const s = state(),
            level = tables.find('abbys_level', id),
            heroes = s.player.heros_info.heros,
            pet = s.pets.at(-1)
        return {
            mode,
            abyss_level: id,
            challenge_list: String(level.dungeonId)
                .split('|')
                .map((d, i) => ({
                    dungeon_id: Number(d),
                    control: heroes[i].guid,
                    heros: [
                        { index: 0, hero: { hero_guid: heroes[i].guid, pet_guid: i === 0 ? pet.guid : '0' } },
                        { index: 1, hero: { hero_guid: '0', pet_guid: '0' } },
                        { index: 2, hero: { hero_guid: '0', pet_guid: '0' } },
                    ],
                })),
        }
    }
    return { tables, p, store, session, game, call, decode, state, request, login, time }
}
