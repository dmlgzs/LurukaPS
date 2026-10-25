import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { gridAnchor, validatePlacement } from '../src/home-grid.js'

export function buildingPlacementFixture(name, file = ':memory:') {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(file)
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.player.basic_info.lv = 45
    })
    const state = () => store.load(session.id).state
    const own = (id, n = 1) => edit((s) => grantRewards(tables, s, [{ itemtype: 13, itemid: id, itemnum: n }]))
    const location = (id, guid = 0) => {
        const block = tables.find('home_block', 101)
        const [x0, y0] = block.blockStartPos.split('|').map(Number)
        const [x1, y1] = block.blockEndPos.split('|').map(Number)
        const previous = state().home.builds.find((b) => b.guid === guid)?.locate
        for (let x = Math.min(x0, x1); x < Math.max(x0, x1); x++)
            for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y++) {
                const locate = { block_id: 101, anchor: gridAnchor(x, y), direction: 0 }
                if (previous?.anchor === locate.anchor) continue
                try {
                    validatePlacement(tables, state(), id, locate, guid)
                    return locate
                } catch {}
            }
        throw Error('No valid actual test placement fits in block101')
    }
    const place = (id, guid = 0, method = 'BuildLocate') => {
        const packets = call(method, { build_id: id, ...(guid ? { guid } : {}), locate: location(id, guid) })
        const entry = protocol.byName.get('CSProto' + method)
        return { packets, build: protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload) }
    }
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        edit,
        state,
        own,
        location,
        place,
        reload() {
            session = {}
            return call('EnterGame', { open_id: name })
        },
        advance(n) {
            now += n
        },
    }
}
