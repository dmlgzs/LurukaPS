import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { populateParty } from './party-fixture.js'

export function rescueFixture(name, filename = ':memory:') {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base)
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    const session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    const entryPackets = call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        populateParty(s)
        s.world.map_id = 100
        s.world.pos = { x: 100, y: 100, z: 100 }
        s.combat = { map_id: 100, entities: {}, skills: {}, elements: {}, bullets: {} }
    })
    const state = () => store.load(session.id).state
    const heroes = state()
        .player.heros_info.heros.slice(0, 3)
        .map((h) => h.guid)
    const saved = (id) => state().player.heros_info.battle_infos.find((h) => h.hero_id === id)
    const overHurt = (id, value = 0) =>
        store.transact(session.id, 0, (s) => {
            Object.assign(
                s.player.heros_info.battle_infos.find((h) => h.hero_id === id),
                { hp: 0, alive_state: 2, rescue_val: value, sp: 7 },
            )
        })
    const rescue = (from, to, val) => call('RescueObj', { rescue_infos: [{ from_uuid: from, tar_uuid: to, val }] })
    const notifications = (packets) =>
        protocol.decode('SCRescueObjNtf', packets.find((p) => p.id === 10739 && !p.audience).payload).rescue_infos
    return {
        entryPackets,
        cfg,
        tables,
        protocol,
        store,
        game,
        session,
        call,
        state,
        saved,
        overHurt,
        rescue,
        heroes,
        notifications,
        sql: () => store.db.prepare('select total_changes() n').get().n,
    }
}
