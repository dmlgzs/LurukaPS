import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'

export function ranchFixture(name, options = {}) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1,
        roll = () => 0
    const game = new Game(protocol, store, tables, { clock: () => now, rng: (max) => roll(max) })
    const session = {}
    const call = (name, data = {}, target = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    let pets
    store.transact(session.id, 0, (s) => {
        s.world.map_id = Number(tables.get('game').find((r) => r.title === 'HOME_ID').value)
        s.player.basic_info.lv = options.level ?? 6
        pets = createPets(tables, s, 500001, options.pets ?? 2).map((p) => p.guid)
        for (const p of s.pets.filter((p) => pets.includes(p.guid))) {
            p.work_status = 0
            p.work_build = 0
            p.capacity_id = 0
            p.labor_infos = []
            p.talent_id = []
            p.satiety_val = 10000
        }
    })
    return {
        tables,
        protocol,
        store,
        game,
        session,
        pets,
        call,
        state: () => store.load(session.id).state,
        close: () => store.close(),
        now: () => now,
        setRoll: (fn) => {
            roll = fn
        },
        elapse: (seconds) => {
            now += seconds
        },
        tick: () => game.tick(session.id),
        assign: (pet = pets[0], slot = 1, role = 1) =>
            call('RanchSetPetOption', { block_id: 201, slot, pet_guid: pet, work_type: role }),
    }
}
