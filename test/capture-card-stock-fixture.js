import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { addItems } from '../src/inventory.js'

const cfg = configuration()
export const cardTables = new Tables(cfg.tables)
export const cardProtocol = new Protocol(cfg.base)
export function cardFixture({
    file = ':memory:',
    openId = 'held-cards',
    now: initial = 1800000000,
    setup = true,
} = {}) {
    let now = initial,
        seq = 1
    const store = new Store(file),
        session = {},
        game = new Game(cardProtocol, store, cardTables, { clock: () => now })
    const call = (name, data = {}) => {
        const entry = cardProtocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? cardProtocol.encode(entry.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: openId })
    if (setup)
        store.transact(session.id, 0, (state) => {
            // Supply ingredients, never completed cards or completion receipts.
            state.player.sbag_infos.items = state.player.sbag_infos.items.filter(
                (item) => cardTables.find('common_item', item.itemid)?.type !== 410,
            )
            addItems(state, [{ itemid: 312001, itemnum: 4000 }])
        })
    return {
        store,
        session,
        game,
        call,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        now: () => now,
        advance: (seconds) => {
            now += seconds
        },
        tick: () => game.tick(session.id),
        make: (count) => {
            call('SimpleProductStart', { product_id: 501001, count, select_material: [] })
            now += count
            return game.tick(session.id)
        },
        close: () => store.close(),
    }
}
