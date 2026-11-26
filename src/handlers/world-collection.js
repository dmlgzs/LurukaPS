import { ensureHome, homePayload } from '../home.js'
import { selectHomeCollectionPlan } from '../home-collection.js'
import { unlockWorldCollection } from '../world-collection.js'
import { claimCollections } from '../collection-claims.js'
import { claimAllBuildRewards } from '../home-aggregate-claims.js'

export function registerWorldCollection(on) {
    on('HomeCollectBuildSwitchProduct', (c, request) => {
        ensureHome(c.tables, c.state)
        selectHomeCollectionPlan(c.tables, c.state, request, c.now)
        c.pushBefore('CSProtoHomeSync', homePayload(c.tables, c.state))
        return {}
    })
    on('GetAllBuildReward', (c, request) => claimAllBuildRewards(c, request))
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
