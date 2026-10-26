import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ensureHome } from '../src/home.js'
import { grantRewards, parseRewards } from '../src/rewards.js'

export const encodeCommand = (command) => ({ command: Buffer.from(command).toString('base64') })
export const homeCurrencyBalance = (state) =>
    BigInt(state.player.attr_infos.attrs.find((row) => row.attr_id === 103)?.attr_val ?? 0)

export function homeCurrencyFixture(name, { filename = ':memory:', start = 1800000000 } = {}) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    const store = new Store(filename)
    let now = start,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, {
        clock: () => now,
        rng: (min, max) => (max === undefined ? 0 : min),
    })
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((state) => {
        state.player.basic_info.lv = 45
        ensureHome(tables, state)
    })
    return {
        tables,
        protocol,
        store,
        game,
        call,
        login,
        edit,
        session: () => session,
        state: () => store.load(session.id).state,
        clock: () => now,
        setNow: (value) => {
            now = value
        },
        tick: (seconds) => {
            now += seconds
            return game.tick(session.id)
        },
        fundItems: (text) => edit((state) => grantRewards(tables, state, parseRewards(text))),
        gm: (command) => call('GMCommand', encodeCommand(command)),
        setOldBalance: (amount) =>
            edit((state) => {
                const attrs = state.player.attr_infos.attrs
                let row = attrs.find((entry) => entry.attr_id === 103)
                if (!row) attrs.push((row = { attr_id: 103, attr_val: '0' }))
                row.attr_val = String(amount)
            }),
    }
}
