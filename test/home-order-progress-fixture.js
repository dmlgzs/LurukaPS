import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'

export function homeOrderFixture(name, file = ':memory:', options = {}) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(file),
        session = {}
    let now = options.now ?? 1792584000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now, rng: (min) => min })
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn)
    if (!options.resume)
        edit((state) => {
            state.player.basic_info.lv = 45
            state.player.sbag_infos.items = []
        })
    const state = () => store.load(session.id).state
    const board = () => {
        call('CSExchangeOrderBoard')
        return state().homeExchange.board
    }
    const submit = (slot) => {
        const current = state().homeExchange.board.slots.find((row) => row.guid === slot.guid)
        const row = tables.get('home_exchange_order').find((row) => row.orderID === current.order_id)
        edit((draft) => grantRewards(tables, draft, parseRewards(row.orderNeedMaterials)))
        return call('CSFinishOrder', { order_guid: slot.guid })
    }
    const complete = (count) => {
        const accepted = []
        while (accepted.length < count) {
            const current = board(),
                open = current.slots.filter((slot) => slot.guid && !slot.done)
            for (const slot of open) {
                if (accepted.length === count) break
                submit(slot)
                accepted.push({ guid: slot.guid, level: slot.level, orderId: slot.order_id })
            }
            if (accepted.length < count) now = current.end
        }
        return accepted
    }
    return {
        cfg,
        tables,
        protocol,
        store,
        session,
        game,
        call,
        edit,
        state,
        board,
        submit,
        complete,
        now: () => now,
        setNow: (value) => {
            now = value
        },
        close: () => store.close(),
    }
}
