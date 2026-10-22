import {
    exchangeHistorySnapshot,
    ensureHomeExchange,
    exchangeBoxSnapshot,
    exchangeNewsSnapshot,
    reserveExchangeItem,
    returnExchangeReservation,
    settleExchangeImmediately,
} from '../home-exchange.js'
import { ensureExchangeOrderBoard, exchangeOrderSnapshot } from '../home-exchange-orders.js'
export function registerHomeExchange(on, tables) {
    on('CSHistoryReport', (c) => exchangeHistorySnapshot(c.state, true))
    on('CSExchangeObjInfo', (c) => {
        ensureHomeExchange(tables, c.state, c.now, c.randomInt)
        c.pushBefore('CSProtoHomeExchangeNewInfo', exchangeNewsSnapshot(c.state))
        c.pushBefore('CSProtoSCHomeexchanceObj', exchangeBoxSnapshot(tables, c.state, c.now))
        return {}
    })
    on('CSAddExchangeObj', (c, r) => {
        const previousMarket = c.state.homeExchange?.market
        reserveExchangeItem(c, r)
        if (previousMarket !== c.state.homeExchange.market)
            c.pushBefore('CSProtoHomeExchangeNewInfo', exchangeNewsSnapshot(c.state))
        c.pushBefore('CSProtoSyncPlayerData', { sbag_infos: c.state.player.sbag_infos })
        c.pushBefore('CSProtoSCHomeexchanceObj', exchangeBoxSnapshot(tables, c.state, c.now))
        return {}
    })
    on('CSCancelExangeObj', (c, r) => {
        returnExchangeReservation(c, r)
        c.pushBefore('CSProtoSyncPlayerData', { sbag_infos: c.state.player.sbag_infos })
        c.pushBefore('CSProtoSCHomeexchanceObj', exchangeBoxSnapshot(tables, c.state, c.now))
        return {}
    })
    on('CSSettleImmediately', (c) => {
        const award = settleExchangeImmediately(c)
        c.pushBefore('CSProtoSyncPlayerData', {
            basic_info: c.state.player.basic_info,
            attr_infos: c.state.player.attr_infos,
            sbag_infos: c.state.player.sbag_infos,
        })
        c.pushBefore('CSProtoSCHomeExchangeInfo', { history: exchangeHistorySnapshot(c.state) })
        return { award, obj_info: exchangeBoxSnapshot(tables, c.state, c.now) }
    })
    on('CSExchangeOrderBoard', (c) => {
        ensureExchangeOrderBoard(c)
        return exchangeOrderSnapshot(c.state)
    })
}
