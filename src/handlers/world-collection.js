import { ensureHome } from '../home.js'
import { unlockWorldCollection } from '../world-collection.js'

export function registerWorldCollection(on) {
    on('CollectBuildCreate', (c, request) => {
        ensureHome(c.tables, c.state)
        unlockWorldCollection(c, request)
        return {}
    })
}
