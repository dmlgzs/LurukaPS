import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'

export const giftTables = new Tables(configuration().tables)
export function heroGiftFixture(name, filename = ':memory:') {
    const protocol = new Protocol(configuration().base),
        store = new Store(filename)
    let now = 1800000000,
        sequence = 1,
        session = {}
    const game = new Game(protocol, store, giftTables, { clock: () => now })
    const frame = (name, r = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return { id: row.id, seq: sequence++, payload: row.req ? protocol.encode(row.req, r) : Buffer.alloc(0) }
    }
    const send = (frame) => game.dispatch(session, frame),
        call = (name, r) => send(frame(name, r))
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => {
        s.tasks = []
        s.player.basic_info.lv = 30
    })
    const normalItem = giftTables.get('hero_favorability_gift')[0].id
    const furniture = giftTables.get('home_dorm_furniture').find((r) => r.heroId === 107002)
    const gift = (num = 1, item = normalItem, heroId = 107002) =>
        call('SendHeroGift', {
            heroId,
            item_id: item,
            item_type: giftTables.find('common_item', item).type,
            num,
        })
    const fund = (id, n) => edit((s) => grantRewards(giftTables, s, [{ itemtype: 3, itemid: id, itemnum: n }]))
    return {
        protocol,
        store,
        game,
        session: () => session,
        frame,
        send,
        call,
        edit,
        state,
        tables: giftTables,
        gift,
        fund,
        normalItem,
        furniture,
        reload: () => {
            session = {}
            return call('EnterGame', { open_id: name })
        },
        advance: (seconds) => {
            now += seconds
        },
    }
}
