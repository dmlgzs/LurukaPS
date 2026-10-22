import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

export function staminaFixture(name, file = ':memory:', start = 1800000000) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base)
    const store = new Store(file, { flushIntervalMs: 60000 })
    let now = start,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    const entryPackets = call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const value = (id) => Number(state().player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val)
    const set = (id, n) =>
        store.transact(session.id, 0, (s) => {
            const row = s.player.attr_infos.attrs.find((a) => a.attr_id === id)
            if (row) row.attr_val = String(n)
            else s.player.attr_infos.attrs.push({ attr_id: id, attr_val: String(n) })
        })
    const balance = (n, full = n >= tables.find('player_level', state().player.basic_info.lv).stamina) => {
        set(3, n)
        set(200030, now)
        store.transact(session.id, 0, (s) => {
            s.staminaRecovery.full = full
        })
    }
    return {
        cfg,
        tables,
        protocol,
        store,
        game,
        session,
        call,
        entryPackets,
        state,
        value,
        set,
        balance,
        now: () => now,
        advance: (n) => {
            now += n
        },
        time: (n) => {
            now = n
        },
        sql: () => store.db.prepare('select total_changes() n').get().n,
    }
}
