import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
export const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
export function setup(file = ':memory:') {
    let now = 1800000000,
        seq = 1
    const store = new Store(file),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'hatch-workers' })
    store.transact(session.id, 0, (s) => {
        s.world.map_id = 701
        s.player.basic_info.lv = 15
        grantRewards(tables, s, [
            { itemtype: 5, itemid: 500023, itemnum: 1 },
            { itemtype: 14, itemid: 40003007, itemnum: 2 },
        ])
        s.home.builds.push({
            guid: 18,
            build_id: 30231,
            build_type: 12,
            status: 1,
            locate: { block_id: 101, anchor: 6750237, direction: 0 },
        })
    })
    const worker = store.load(session.id).state.pets.find((p) => p.config_id === 500023).guid
    return {
        store,
        session,
        game,
        call,
        worker,
        state: () => store.load(session.id).state,
        advance: (n) => {
            now += n
            return game.tick(session.id)
        },
        now: () => now,
        close: () => store.close(),
    }
}
export const station = (f) => f.call('PetStationed', { pet_guid: f.worker, build_guid: 18, build_type: 1 })
export const start = (f, id = 1) => f.call('HatchPetEgg', { build_guid: 18, egg_guid: id })
export const jobs = (f) => f.state().home.productionJobs[18]
