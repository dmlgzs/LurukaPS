import {
    exchangeHistorySnapshot,
    ensureHomeExchange,
    exchangeBoxSnapshot,
    exchangeNewsSnapshot,
    reserveExchangeItem,
} from '../home-exchange.js'
export function registerHomeExchange(on, tables) {
    on('CSHistoryReport', (c) => exchangeHistorySnapshot(c.state, true))
    on('CSExchangeObjInfo', (c) => {
        ensureHomeExchange(tables, c.state, c.now, c.randomInt)
        c.pushBefore('CSProtoHomeExchangeNewInfo', exchangeNewsSnapshot(c.state))
        c.pushBefore('CSProtoSCHomeexchanceObj', exchangeBoxSnapshot(tables, c.state, c.now))
        return {}
    })
    on('CSAddExchangeObj', (c, r) => {
        reserveExchangeItem(c, r)
        c.pushBefore('CSProtoSyncPlayerData', { sbag_infos: c.state.player.sbag_infos })
        c.pushBefore('CSProtoSCHomeexchanceObj', exchangeBoxSnapshot(tables, c.state, c.now))
        return {}
    })
}
