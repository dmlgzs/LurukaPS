import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'

export const tables = new Tables(configuration().tables)
export function giftFor(heroId) {
    return tables
        .get('hero_favorability_gift')
        .map((row) => ({
            row,
            value: String(row.favourHero).split('|').map(Number).includes(heroId) ? row.favourValue : row.normalValue,
        }))
        .sort((a, b) => b.value - a.value)[0]
}
export function favorProgressFixture(name, filename = ':memory:') {
    const protocol = new Protocol(configuration().base),
        store = new Store(filename),
        session = {}
    let now = 1800000000,
        sequence = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: row.id,
            seq: sequence++,
            payload: row.req ? protocol.encode(row.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn)
    const state = () => store.load(session.id).state
    edit((s) => {
        s.tasks = []
        s.player.basic_info.lv = 30
    })
    const actor = (id) => state().player.heros_info.heros.find((row) => row.conf_id === id && !row.trail)
    const fund = (id, count) => edit((s) => grantRewards(tables, s, [{ itemtype: 3, itemid: id, itemnum: count }]))
    const gift = (heroId, itemId, num = 1) => call('SendHeroGift', { heroId, item_id: itemId, item_type: 110, num })
    const raise = (heroId) => {
        const selected = giftFor(heroId)
        const cap = Number(tables.get('game').find((r) => r.title === 'HERO_FAVORABILITY_GIFT_NUM').value)
        const total = Number(tables.get('game').find((r) => r.title === 'HERO_FAVORABILITY_ALL_GIFT_NUM').value)
        const curve = tables.get('hero_favorability_exp')
        let requests = 0
        while (actor(heroId).favorability_lv < 10) {
            const current = actor(heroId)
            const remaining =
                curve
                    .filter((r) => r.favorabilityLevel >= current.favorability_lv && r.favorabilityLevel < 10)
                    .reduce((n, r) => n + r.favorabilityExp, 0) - (current.favorability_exp ?? 0)
            gift(heroId, selected.row.id, Math.min(cap, total, Math.ceil(remaining / selected.value)))
            requests++
            // Real handler refreshes the next day's configured quotas; no
            // gift counter, level or achievement receipt is edited here.
            now += 86400
        }
        return requests
    }
    return {
        protocol,
        store,
        session,
        game,
        call,
        edit,
        state,
        actor,
        fund,
        gift,
        raise,
        advance: (seconds) => {
            now += seconds
        },
        close: () => store.close(),
    }
}
