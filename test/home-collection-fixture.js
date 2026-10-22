import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

const cfg = configuration()
export const tables = new Tables(cfg.tables)
export const protocol = new Protocol(cfg.base)
export function fixture() {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now, rng: (min) => min })
    const decode = (packets) =>
        packets.map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return decode(game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) }))
    }
    call('EnterGame', { open_id: 'home-collection' })
    store.transact(session.id, 0, (state) => {
        state.world.map_id = Number(tables.get('game').find((r) => r.title === 'HOME_ID').value)
        state.home.level = 30
        const p = state.pets[0]
        p.work_status = 0
        p.work_build = 0
        p.hero_id = '0'
        p.satiety_val = 100
        p.talent_id = []
        p.labor_infos = [3, 4, 7, 9].map((labor_id) => ({ labor_id, labor_grade: 1 }))
        for (const [i, config] of tables.get('home_building_homecollection').entries())
            state.home.builds.push({
                guid: 100 + i,
                build_id: config.id,
                build_type: 24,
                status: 1,
                locate: { block_id: 101, anchor: 6750200 + i, direction: 0 },
            })
    })
    return {
        store,
        session,
        game,
        call,
        worker: store.load(session.id).state.pets[0].guid,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        now: () => now,
        advance: (seconds, tick = true) => {
            now += seconds
            return tick ? decode(game.tick(session.id)) : []
        },
        close: () => store.close(),
    }
}
