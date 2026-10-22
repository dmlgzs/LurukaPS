import { ensureHome } from '../home.js'
import { unlockWorldCollection } from '../world-collection.js'
import { claimCollections } from '../collection-claims.js'

export function registerWorldCollection(on) {
    on('CollectGetReward', (c, request) => {
        ensureHome(c.tables, c.state)
        return claimCollections(c, request)
    })
    on('CollectBuildCreate', (c, request) => {
        ensureHome(c.tables, c.state)
        unlockWorldCollection(c, request)
        return {}
    })
}
