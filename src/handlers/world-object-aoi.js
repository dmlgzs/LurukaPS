import { createWorldObjectAoi, deleteWorldObjectAoi, dynamicWorldObjectSnapshot } from '../world-object-aoi.js'

export function registerWorldObjectAoi(on, tables) {
    on('TryCreateWorldObj', createWorldObjectAoi)
    on('TryDeleteWorldObj', deleteWorldObjectAoi)
    // SC-prefixed in the current dictionary, but its actual Native sender is
    // C2S9199.9200 fills the remote cache and releases pending callbacks.
    on('SCProtoDynamicObjInfosReq', (c, request) => {
        c.push('SCProtoDynamicObjInfosSync', dynamicWorldObjectSnapshot(tables, c.state, request.u32))
        return {}
    })
}
