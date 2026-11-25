import { configuration } from './config.js'
import { startServer } from './server.js'
const config = configuration()
const server = await startServer(config)
console.log(
    `LurukaPS ${server.game.protocol.clientVersion ?? config.version}: TCP ${server.tcp.address().address}:${server.tcp.address().port}, HTTP ${server.web.address().port}`,
)
console.log(
    `Runtime ${server.runtime.revision}; local payments=${server.runtime.offlinePayments}; handlers=${server.game.handlers.size}; source=${config.base}`,
)
console.log('Local sandbox: client connection and gameplay compatibility still under validation.')
let closing = false
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
        if (closing) return
        closing = true
        await server.close()
    })
