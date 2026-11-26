import { startHatch } from '../hatching.js'
import { refreshProduction } from '../production.js'
export function registerHatching(on) {
    on('HatchPetEgg', (c, r) => {
        startHatch(c, r.build_guid, r.egg_guid)
        refreshProduction(c.state, c.now)
        return {}
    })
    // Current petAction.req_hatchOutPetEgg / req_cancelHatchPetEgg use
    // ProductFinish / ProductCancel with product GUIDs. Their shared
    // production-claims path calls claimHatch/cancelHatch and keeps receipts.
}
