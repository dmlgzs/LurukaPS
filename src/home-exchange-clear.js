import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { returnExchangeReservation, exchangeBoxSnapshot } from './home-exchange.js'

//6201 clears the shared, still-editable selection. Departed batches are owned
// by prepareHomeExchange and must never be turned back into inventory here.
export function clearExchangeReservations(c) {
    const box = c.state.homeExchange?.box ?? []
    ensure(Array.isArray(box), 'Saved shipment selection is malformed', ErrorCode.GameConfig)
    const ids = [...new Set(box.map((entry) => entry.id))]
    for (const id of ids) {
        ensure(
            Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff,
            'Saved shipment item identity is malformed',
            ErrorCode.GameConfig,
        )
    }
    // Each restoration uses the original stack GUID, amount and expiration
    // proof. The request's Store transaction rolls the whole set back on error.
    for (const id of ids) returnExchangeReservation(c, { id })
    c.pushBefore('CSProtoSyncPlayerData', { sbag_infos: c.state.player.sbag_infos })
    c.pushBefore('CSProtoSCHomeexchanceObj', exchangeBoxSnapshot(c.tables, c.state, c.now))
    return {}
}
