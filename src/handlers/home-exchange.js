import { exchangeHistorySnapshot } from '../home-exchange.js'
export function registerHomeExchange(on) {
    on('CSHistoryReport', (c) => exchangeHistorySnapshot(c.state, true))
}
