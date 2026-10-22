import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { addItems } from '../src/inventory.js'
import itemRows from '../configs/inventory-tables/common_item.json' with { type: 'json' }

const config = configuration(),
    tables = new Tables(config.tables)
export const quickIds = itemRows.filter((row) => row.isQuickBar === 1).map((row) => row.id)
export const nonQuickId = itemRows.find((row) => row.isQuickBar !== 1).id
export function shortcutFixture(file = ':memory:') {
    const protocol = new Protocol(config.base),
        store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now })
    let now = 1800000000,
        sequence = 1
    const account = store.login('shortcuts-a', (id, open) => seedPlayer(tables, id, open)),
        other = store.login('shortcuts-b', (id, open) => seedPlayer(tables, id, open)),
        session = { id: account.id, token: 'shortcut-test' }
    const edit = (fn) => store.transact(session.id, 0, fn)
    const call = (name, data = {}, actor = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(actor, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    return {
        protocol,
        store,
        game,
        session,
        other,
        edit,
        call,
        state: () => store.load(session.id).state,
        add: (itemId, slot) =>
            call('ShortcutKeySet', {
                type: 1,
                item: { src_item: { slot_id: 0, item_id: itemId }, tar_item: { slot_id: slot, item_id: 0 } },
            }),
        remove: (itemId, slot) =>
            call('ShortcutKeySet', { type: 1, item: { src_item: { slot_id: slot, item_id: itemId } } }),
        swap: (from, fromId, to, toId = 0) =>
            call('ShortcutKeySet', {
                type: 1,
                item: { src_item: { slot_id: from, item_id: fromId }, tar_item: { slot_id: to, item_id: toId } },
            }),
        grant: (ids = quickIds.slice(0, 7)) =>
            edit((s) =>
                addItems(
                    s,
                    ids.map((itemid) => ({ itemid, itemnum: 2 })),
                ),
            ),
        now: () => now,
        advance: (n) => {
            now += n
        },
    }
}
